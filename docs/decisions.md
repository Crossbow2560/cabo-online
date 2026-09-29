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

## Arrival order instead of locks for snap races
Node processes one socket handler at a time, and `applyAction` is synchronous. The first valid snap therefore wins, and later ones are rejected as `too_slow` with no penalty. Snaps are checked against a `windowId` rather than the state version, because several players snap the same window concurrently. Other turn actions carry `expectedVersion`, to reject double clicks and stale screens.

## In-memory live state, Postgres snapshots
Every action updates memory, and then a snapshot is upserted asynchronously, chained per room and version-guarded (`where games.version <= excluded.version`).
- Gameplay never waits on the database.
- A restart rehydrates rooms and gives players time to reconnect before timers resume.

**Trade-off:** it's a single server instance. Horizontal scaling would need the Socket.IO Redis adapter and room ownership, which isn't implemented.

## Guest sessions, bearer token in localStorage
There are no accounts; a nickname returns a random token, and the server stores only its sha256.
- One live socket per session: a new tab replaces the old one. The new socket registers first, so the replacement doesn't mark the player offline.
- Only a 401 clears the stored token. A 5xx or network error (e.g. during a deploy) retries instead of logging the player out.

## Offline handling: kick after 5 minutes, hold the peek
- **Kick:** a disconnected player keeps their seat and the turn timers auto-play for them. After 5 minutes offline they're removed (`REMOVE_PLAYER`), and fewer than 2 players ends the round as "last one standing".
- **Peek hold:** the peek phase waits for offline players (up to 60s), so a phone that was reconnecting at the start of a round still gets to see its two cards.

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
The source rules are ambiguous in places. [PLAN.md](../PLAN.md) records each ruling (R1–R28), for example:
- Abilities trigger only when a stock-drawn card is discarded directly (R7).
- Snapping an opponent's card makes giving a card into the gap optional (R17).
- A black King looks at an opponent's card **and** one of your own, then optionally swaps them (R10).

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
