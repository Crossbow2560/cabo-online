# Technical decisions

## Server-authoritative engine, redacted views
Cabo is a hidden-information game with races, so a client-side model would leak cards through devtools and let players cheat snaps.

**Decision:**
- The server holds the only full state.
- Clients receive `redactFor(state, me)`: their own cards only while entitled (the peek phase, the drawn card, the round end), plus private events for peek results.
- Motion data carries card faces only when they're already public; a fuzz test checks this.

**Trade-off:** every UI change needs a server round-trip. That's acceptable for a turn-based game at this scale.

## A pure engine with injected time and RNG
`applyAction(state, action, now)` is deterministic: the RNG state is stored in `GameState.rng`, and `now` is passed in.
- It is unit-testable without mocks, and fuzz-testable (thousands of random actions with invariants).
- It is replayable. The dev-only `CABO_SEED` deals a known deck for manual testing.
- The server stays thin. Timeouts are just `TICK` actions the engine resolves ("draw and discard", "skip ability").

**Considered:** a full event log with replay (a `game_events` table). It was dropped in favour of snapshots, which are enough for crash recovery.

## Snap races decided by reaction time, not arrival
First-to-arrive favoured good connections: a player on mobile data could tap first and still lose. So each snap window is resolved as a batch (`RoomManager.snap` / `resolveSnaps`):
- Each client times its window from when it **sees** it and reports its reaction time (`reactionMs`), or a "no snap" pass when its window ends.
- The server waits until the window is over and every online human has answered, or for at most `snapGraceMs` (1.5s) after it. A disconnected player isn't waited for.
- It then replays the snaps through the engine in reaction-time order, each with a server-set `at` time for the window check. The engine's rules are unchanged: first correct snap wins, earlier wrong snaps are penalised, later correct ones are too slow.

**Why reaction times, not timestamps:** device clocks can differ by seconds, and a timestamp includes the time the window took to reach that player. A reaction time measured on the player's own screen cancels both.

**Trust:** a client could under-report. Claims are clamped to at least 120ms and to no more than the time actually elapsed when the snap arrived, which is enough for a casual game among friends. Bots are timed by the server.

**Trade-off:** a snap's result appears when the window closes (≈3.5s plus the slowest player's lag), not the instant someone taps.

Snaps are matched to a `windowId` rather than the state version, because several players snap the same window concurrently. Other turn actions carry `expectedVersion`, to reject double clicks and stale screens.

## In-memory live state, Postgres snapshots
Every action updates memory, and then a snapshot is upserted asynchronously, chained per room and version-guarded (`where games.version <= excluded.version`).
- Gameplay never waits on the database.
- A restart rehydrates rooms and gives players time to reconnect before timers resume.

**Trade-off:** it's a single server instance. Horizontal scaling would need the Socket.IO Redis adapter and room ownership, which isn't implemented.

## Guest sessions, bearer token in localStorage
There are no accounts; a nickname returns a random token, and the server stores only its sha256.
- One live socket per session: a new tab replaces the old one. The new socket registers first, so the replacement doesn't mark the player offline.
- Only a 401 clears the stored token. A 5xx or network error (e.g. during a deploy) retries instead of logging the player out.
- `?profile=<name>` switches to a separate storage key (`cabo.token.<name>`), so several players can share one browser. It exists for playtesting with bots ([bots](bots.md)) and grants nothing a private window wouldn't.

## Offline handling: kick after 5 minutes, hold the peek
- **Kick:** a disconnected player keeps their seat and the turn timers auto-play for them. After 5 minutes offline they're removed (`REMOVE_PLAYER`), and fewer than 2 players ends the round as "last one standing".
- **Peek hold:** the peek phase waits for offline players (up to 60s), so a phone that was reconnecting at the start of a round still gets to see its two cards.

## Spectators get a seatless redacted view
A spectator is not a player: they're tracked per room in memory (`Room.spectators`) and sent `redactFor(state, spectatorId)`. Because that id owns no seat, the view has no own cards, no peek phase cards and no drawn card, so watching can't leak anything, including to a friend at the table. Private events are addressed to players only, so spectators get public events via the room channel.

## Pause and end game
- **Pause** lives on the server's room (`Room.paused`), not in the engine: it only stops the room's timer and bots, and on resume shifts the current deadline (and the peek hold) by the paused time. It isn't persisted, so a server restart resumes play. Snap windows can't be paused, because each client times its own.
- **End game** keeps the room and its players: the final standings are sent once in `RoomState.final`, then totals and the round count reset for a new game.

## Sounds: Web Audio, driven by the animation layer
- Card sounds are played from `lib/motion.ts`, which already knows every card movement and its timing, so a sound lands when the animation does. Non-movement cues (your turn, CABO, the reveal) come from `Game.tsx`.
- `lib/sound.ts` uses the Web Audio API with a master gain feeding game and music gains: exact scheduling, cheap overlapping playback, and per-category volume. The audio context is created on the first tap or key press, because browsers block audio before that.
- Clips are "Casino Audio" by Kenney (CC0), converted from Ogg to small mono MP3s (`apps/web/public/sounds`, ~160KB), since older Safari can't decode Ogg.
- Music is `apps/web/public/music/background.mp3` (supplied by the project owner), trimmed of its silent ends, loudness-normalised to the same level as before and re-encoded (2.6MB, 3:09). It streams through an `<audio>` element routed into the music gain (`createMediaElementSource`) instead of being decoded into memory: a decoded 3-minute stereo track is ~65MB. Screens that want it (lobby, table) call `useMusic()`; stopping is delayed briefly so moving from the lobby to the table doesn't restart it. It only plays when audible, and pauses in background tabs.

## Timers
Defaults (`DEFAULT_TIMINGS`):

| Phase | Time |
|---|---|
| Peek | 20s |
| Turn | 60s |
| Ability / give choice | 15s |
| Snap window | 3.5s |

The snap window opens **after** the action and ability resolve (ruling R12), so an ability's target can't disappear mid-ability.

## Rule interpretations
The source rules are ambiguous in places. [PLAN.md](../PLAN.md) records each ruling (R1–R30), for example:
- Abilities trigger only when a stock-drawn card is discarded directly (R7).
- Snapping an opponent's card makes giving a card into the gap optional (R17).
- A black King looks at an opponent's card **and** one of your own, then optionally swaps them (R10).

## Bots run on the server
The lobby's **Add bot** seats a player that the server drives itself, instead of a hidden browser or a separate bot client.
- It works on any deployment with no extra processes or tabs, and survives restarts like any seat.
- Fairness is structural: a bot's input is its redacted view plus its own events, exactly what a client would get, and its moves go through `applyAction` like anyone's.
- A bot's session uses a `bot:` token-hash marker instead of a new column, so no migration is needed and no token can ever match it.

**Kept alongside it:** `tools/browser-bot.js`, a browser bot that clicks the real UI, for testing the client itself.

## Supabase as plain Postgres
Supabase is used only as managed Postgres, through a direct connection string. RLS is enabled with no policies, so its public APIs can't read game state.

**Considered:** Supabase Realtime and Edge Functions. Rejected, because hiding cards and deciding races fairly is simpler with one authoritative Node process.

## One container, same origin
The server serves `apps/web/dist`, so the page, the API and the sockets share an origin:
- no CORS setup,
- invite links work anywhere,
- one Docker image for any domain (`PUBLIC_URL` is read at runtime, not baked into the build).

**Considered:**
- Vercel for the client: rejected because serverless can't hold long-lived sockets.
- Separate subdomains: rejected because they add cross-origin configuration for no benefit.

## A client without a router or state library
The app has three pre-game screens and one table, so a `screen` state and a few `useState`s are enough. The theme is hand-written CSS with four palette tokens, plus a single rust red used only for hearts and diamonds.

## Animations from server motion data
The client can't infer "which card moved where" from two views, because hidden cards look identical. So the engine attaches a `motion` to each public event:
- The client records card positions and looks when the event arrives (before re-render).
- After render, it flies two-sided clones between them.
- Layout is kept stable on purpose: fixed-size prompt and action areas, and a reserved drawn-card spot. Messages never move cards, and the "settle" glide only has to handle real layout changes.
