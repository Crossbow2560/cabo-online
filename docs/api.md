# API

The server exposes a small HTTP API for sessions and config, and a Socket.IO API for rooms and gameplay. Types live in `packages/engine/src/protocol.ts`, `state.ts` and `view.ts`.

## HTTP

### `POST /api/session`
Creates a guest session.

- **Request:** `{ "nickname": "Ana" }` (1–8 characters after trimming).
- **200:** `{ "sessionId": "uuid", "nickname": "Ana", "token": "64 hex chars" }`. Keep the token; it's the bearer credential.
- **400:** `{ "error": "Nickname must be 1-8 characters" }`
- **503:** `{ "error": "Server busy, try again" }` (store unavailable)
- **429:** `{ "error": "Too many requests, slow down" }` with a `Retry-After` header (more than 10 per minute from one IP)

```bash
curl -s -X POST localhost:3101/api/session -H 'content-type: application/json' -d '{"nickname":"Ana"}'
```

### `GET /api/session`
Checks a stored token and says whether the player is seated somewhere.

- **Header:** `Authorization: Bearer <token>`
- **200:** `{ "sessionId": "uuid", "nickname": "Ana", "roomCode": "ABC123" | null }`. A nickname saved before the 8-character limit comes back trimmed to 8.
- **401:** unknown token. The client clears its token only in this case.
- **503:** store unavailable. The client keeps the token and retries with backoff.
- **429:** more than 60 per minute from one IP. Retried like a 503.

### `GET /api/config`
Runtime configuration for the client.

- **200:** `{ "publicUrl": "https://cabo.nishit-db.com" | null, "umami": { "scriptUrl": "…/script.js", "websiteId": "…" } | null }`. `publicUrl` comes from `PUBLIC_URL` with any trailing slash removed; `umami` is set only when both `UMAMI_SCRIPT_URL` and `UMAMI_WEBSITE_ID` are (see [analytics.md](analytics.md)).

### Rate limits

All limits are in memory, per server process, over a sliding window. The defaults are in `RATE_LIMITS` (`apps/server/src/server.ts`), and `createCaboServer({ rateLimits })` can override them (or turn them off with `false`, as the tests do). Behind a proxy, set `TRUST_PROXY=1` so the limits key on the real client IP.

| What | Key | Limit | Over the limit |
|---|---|---|---|
| `POST /api/session` | IP | 10 / minute | `429` |
| `GET /api/session` | IP | 60 / minute | `429` |
| Socket connection | IP | 30 / minute | `connect_error` `rate_limited` |
| Any socket event | session | 20 / second | ack `{ ok: false, error: 'Slow down' }` |
| `room:create` / `room:join` / `room:spectate` | session | 10 / minute | ack `Slow down` |
| `game:snap` (R28) | socket | 5 / second | ack `Slow down` |
| `chat:send` | session | 5 / 10 seconds | ack `Slow down` |

Any other path serves `apps/web/dist/index.html` (SPA fallback) when the build exists.

## Socket.IO

Connect with `io(url, { auth: { token } })`.

- **Connection errors:**
  - `unauthorized`: bad or missing token. Sign in again.
  - `unavailable`: transient store error. Retry.
  - `rate_limited`: more than 30 connection attempts per minute from one IP. Retry after a pause.
- **On every connection:** the server sends the player's current state right away: `room:state` (or `null`) and `game:view` (or `null`).
- **One socket per session:** opening a second one sends `session:replaced` to the older socket and disconnects it.

Client → server events take an acknowledgement callback, which receives `{ ok: true, ... } | { ok: false, error: string }`.

### Client → server

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `room:create` | none | `{ ok, code }` | Six-character code (no 0/O/1/I). The creator is host and seat 0. |
| `room:join` | `{ code }` | `{ ok, code }` | Allowed in `lobby`/`finished`. `A round is in progress` for newcomers mid-round; existing seats just reconnect. Maximum 8 players. |
| `room:spectate` | `{ code }` | `{ ok, code }` | Watch a room without a seat, at any stage (max 20 watchers). The watcher gets `room:state` and a `game:view` with no seat (every card face-down until the reveal) and public log events only. Not allowed while seated somewhere. `room:join` in the lobby turns a watcher into a player. |
| `room:leave` | none | `{ ok }` | Mid-round this forfeits: your cards go back to the stock, and if one player remains they win. |
| `room:start` | none | `{ ok }` | Host only, 2+ players. Starts round 1 or the next round; the dealer rotates left. |
| `room:settings` | any of `{ maxPoints, peekMs, turnMs, choiceMs, snapMs }` | `{ ok }` | Host only, not mid-round. Values must be within `SETTING_LIMITS` and on their step (`maxPoints` may be `null` = no limit); otherwise `Bad value for <key>`. Saved in `rooms.settings`; the next round uses the timers. |
| `room:end` | none | `{ ok }` | Host only, between rounds (`Finish the round first` otherwise). Sets `RoomState.final`, resets totals and round number, back to `lobby`; everyone's `game:view` becomes `null`. |
| `room:pause` | none | `{ ok }` | Anyone seated, mid-round. Freezes timers and bots; moves and snaps get `The game is paused`. Refused during a snap window (`Wait for the snap window to close`). |
| `room:resume` | none | `{ ok }` | Anyone seated. Deadlines move later by the time spent paused. |
| `room:addBot` | `{ level }` | `{ ok }` | Host only, not mid-round. Seats a server-driven bot; `level` is `beginner`, `novice`, `intermediate` (default) or `expert` (see [bots](bots.md)). `Unknown bot level` otherwise. |
| `room:removeBot` | `{ id }` | `{ ok }` | Host only, not mid-round. `No such bot` if `id` isn't a bot in the room. |
| `room:kick` | `{ id }` | `{ ok }` | Host only, at any time. Removes a player (human or bot) or a spectator. Mid-round a player forfeits exactly as with `room:leave`: their cards leave the table, and if one player remains they win. A removed person gets `room:kicked`, then `room:state` `null`, and can't `room:join` or `room:spectate` that room again (`The host removed you from this room`). The ban is in memory only, so a server restart forgets it. Errors: `Only the host can remove people`, `You can't remove yourself. Leave instead`, `No such player`. |
| `game:action` | `ClientAction` | `{ ok }` | See the actions table below. Include `expectedVersion` (from the last `game:view`) to reject stale clicks. |
| `game:snap` | `{ windowId, ownerId, slot, reactionMs }` | `{ ok }` | Queues your snap for this window (one per player). `reactionMs` = time from this client seeing the window to the tap; clamped server-side to ≥120ms and ≤ the time elapsed on arrival. The outcome arrives as `game:log` events when the window resolves; a lost race gets a private "Too slow — someone snapped first". Errors: `You already snapped this time`, `Too slow — the snap window is closed`. Rate-limited to 5 per second per socket. |
| `game:snapPass` | `{ windowId }` | `{ ok }` | "My window ended and I didn't snap": lets the server resolve the window without waiting out the 1.5s grace. |
| `chat:send` | `{ text }` or `{ quick }` | `{ ok }` | Anyone seated or watching, at any stage (also while paused). `text` has control characters removed and whitespace collapsed, and must then be 1–`CHAT_MAX_LEN` (200) characters. `quick` is an id from `QUICK_CHATS`. Relayed to the room as `chat:message`; nothing is stored. Errors: `Not in a room`, `Say something first`, `Keep it under 200 characters`, `Unknown quick chat`. |

**`ClientAction` types** (`playerId` is filled in by the server):

| `type` | Fields | Phase |
|---|---|---|
| `READY` | none | `peek` |
| `DRAW_STOCK` | none | `choose` |
| `TAKE_DISCARD` | `slot` | `choose` |
| `CALL_CABO` | none | `choose` |
| `KEEP` | `slot` | `drawn` |
| `DISCARD_DRAWN` | none | `drawn` |
| `PEEK_OWN` | `slot` | `ability` (7/8, or the Black King's second step) |
| `PEEK_OTHER` | `targetId`, `slot` | `ability` (9/10, or the Black King's first step) |
| `BLIND_SWAP` | `mySlot`, `targetId`, `slot` | `ability` (J/Q) |
| `SWAP` | `mySlot`, optional `targetId`, `slot` (default: the other player's card you looked at) | `ability` (Black King, after both peeks). Any of your cards with any other player's card. |
| `SKIP` | none | `ability`, `give`, or your own snap streak (`snap` with `snapOnlyFor` = you) to end it |
| `GIVE_CARD` | `mySlot` | `give` (after snapping an opponent's card) |

**Rule rejections** come back as `{ ok: false, error }`, e.g.:
- `It's not your turn`
- `Game state changed, try again` (stale `expectedVersion`)
- `Too slow — the snap window is closed`
- `That slot is empty`
- `Look at one of your own cards first`

### Server → client

| Event | Payload | When |
|---|---|---|
| `room:state` | `RoomState \| null` | On connect, and on any room change (joins, leaves, host, connection status, totals). `null` = not seated in any room. |
| `game:view` | `PlayerView \| null` | After every accepted action, for each player, redacted for them. |
| `game:log` | `GameEvent & { at }` | Each engine event. Public ones go to the room; private ones (`to` set) only to that player. |
| `session:replaced` | none | This socket was replaced by a newer one for the same session. |
| `room:kicked` | `{ code }` | The host removed you from room `code`. `room:state` `null` follows. |
| `chat:message` | `ChatMessage` | Someone in the room sent `chat:send`. Goes to every player and spectator in the room, the sender included. |

**`RoomState`:**
- `code`, `hostId`
- `status` (`lobby` / `playing` / `finished`), `roundNo`
- `kickAfterMs`
- `players[]`: `{ id, name, connected, bot, botLevel, offlineSince, totalScore }` (`botLevel` is `null` for humans)
- `spectators`: `{ id, name }[]`
- `settings`: `{ maxPoints, peekMs, turnMs, choiceMs, snapMs }` (the lobby ⚙ settings)
- `limitHit`: between rounds, the players whose total has reached `maxPoints` (non-empty = game over; `room:start` is refused)
- `paused`: `{ byId, byName } | null`
- `final`: `{ standings: { id, name, total }[], winners, rounds, losers, reason: 'limit' | 'host' } | null`, the last game's final totals (lowest first), until the next deal

**`ChatMessage`:** `{ id, fromId, fromName, spectator, text, quick, at }`. `spectator` is true when the sender was watching without a seat; `quick` is the quick-chat id, or `null` for typed text. Clients render `text` as plain text.

**`PlayerView`** (key fields):
- `you`, `version`, `phase`, `currentPlayerId`, `dealerId`
- `deadline` (epoch ms), `caboCalledBy`
- `stockCount`, `discardTop`
- `players[]`: `{ id, name, ready, slots: ({ card: Card | null } | null)[] }`. A `null` slot is a gap; `card: null` is face-down to you.
- `drawnCard`: yours only.
- `ability`, `abilityPeeked`, `abilityPeekedMine`
- `snapWindowId`, `snapMs` (window length; clients time it from when they see it), `snapOnlyFor` (set during a snap streak: only that player may snap, their own cards), `give`
- `result`: `{ reason, scores, winners }` when the round has ended.

**`GameEvent`:**
- `text`: a human-readable log line.
- `to?`: set when the event is private to that player.
- `reveal?`: private peek result, `{ playerId, slot, card }`.
- `motion?`: animation data.
  - `moves[]`: `{ from, to, card? }`
  - `flash[]`: a wrong snap, with the revealed card.
  - `peek[]`: `{ spot, by }`

  A spot is `slot`, `stock`, `discard` or `held` (a drawn card).
