# Architecture

## Overview

```
 Browser (React)                       Node server                               Supabase Postgres
 ───────────────                       ───────────                               ─────────────────
 screens / table  ◀── room:state ───   RoomManager ── applyAction() ──▶ engine   guest_sessions
 lib/motion.ts    ◀── game:view ────    per room:    (pure, synchronous)         rooms / room_players
                  ◀── game:log ─────    state, timers, redactFor()               games (state snapshot)
                  ── game:action ──▶    kick timers        │
                  ── game:snap ────▶                       └── persist() ───────▶
 HTTP: /api/session, /api/config  ──▶  Express
```

There are three layers, each with one job:

| Layer | Package | Owns |
|---|---|---|
| Rules | `packages/engine` | Game state, every rule, redaction, motion data. No I/O and no clock (time is passed in). |
| Transport + orchestration | `apps/server` | Sessions, rooms, seating, timers, auto-kick, persistence, fan-out of views and events. |
| Presentation | `apps/web` | Screens, table layout, input, and animations. It never decides rules. |

## The engine (`packages/engine`)

- `createGame({ players, seed, dealerIndex, now, timings })`: shuffles a 54-card deck with a seeded mulberry32 RNG and deals 4 cards each, starting left of the dealer. It turns up the first discard and enters the `peek` phase.
- `applyAction(state, action, now) → { ok, state, events } | { ok: false, error }`:
  - It `structuredClone`s the state and dispatches on the action type.
  - It throws a typed `Reject` for illegal moves, e.g. `stale`, `not_your_turn`, `wrong_phase`, `invalid`, `too_slow` and `not_due`.
  - The input state is never mutated.
- **Phases** (a `Phase` discriminated union in `state.ts`), in order:
  1. `peek`
  2. `choose`
  3. `drawn`
  4. `ability`
  5. `snap`
  6. `give`
  7. `ended`

  Each phase has a deadline. The server fires `TICK` when it passes, and the engine auto-plays: it draws and discards, skips the ability, or closes the window.
- **Turn order:** after a turn's action (and ability), a snap window opens, then the turn advances. After CABO, `finalTurnsRemaining` counts down, so the round ends correctly even if the caller leaves.
- **Removal:** `REMOVE_PLAYER` (a system action) takes a leaving or kicked player out mid-round and repairs turn and dealer indices. If fewer than 2 players remain, the round ends with the survivor as winner (`forfeit`).
- **Redaction:** `redactFor(state, viewerId)` is the only function that turns state into client data. A card value is included only for:
  - your own nearest two cards during `peek`,
  - your drawn card,
  - everything at `ended`.

  Peek results are sent as private events (`to: playerId`, with `reveal`).
- **Motion:** each public event can carry `motion`, which lists the moves (`from`/`to` spots), wrong-snap flashes and peeks (who looked at which slot). A card face is attached only when that card is already public (going to or from the discard, or a wrong-snap reveal). A fuzz test enforces this.

## The server (`apps/server`)

- **`server.ts`:**
  - Express routes: `POST /api/session` and `GET /api/session` for guest sessions, and `GET /api/config` for the runtime `PUBLIC_URL`. It also serves static files from `apps/web/dist`.
  - Socket.IO auth middleware: resolves a session from a hashed token.
  - Event handlers: shape-check the input (`parseAction`); the engine does all rule checks.
- **`rooms.ts` (`RoomManager`):**
  - **Room lifecycle:** create, join, leave, start (with dealer rotation).
  - **`apply()`:** runs the engine, then fans out views, public logs (`r:<code>`) and private logs (`s:<sessionId>`). It adds round scores to running totals and persists.
  - **Timers:** one per room, firing `TICK` at the current phase deadline. The peek phase is held open (up to 60s) while a seated player is offline.
  - **Kick timers:** a player who stays offline for 5 minutes is removed.
  - **Restore on boot:** open rooms and their latest game snapshot are rehydrated.
- **`store.ts`:** a `Store` interface with two implementations. `PgStore` (postgres.js) writes transactional room upserts and version-guarded game snapshots. `MemoryStore` is used when `DATABASE_URL` is unset.
- **Ordering:** `applyAction` is synchronous, and Node runs one socket handler at a time. So actions, including two players snapping at once, are applied strictly in arrival order with no locks. Persistence is chained per room (`persistChain`), so snapshots land in order without blocking gameplay.

## The client (`apps/web`)

- **`App.tsx`:**
  - A screen state machine: `landing` → `nickname` → `play`.
  - Holds the guest token in `localStorage`. Only a 401 clears it; 5xx and network errors are retried.
  - Owns the socket. The client waits for the server's first `room:state` after every (re)connect ("Saddling up…"), so it never renders a stale table.
- **Screens:**
  - `Landing`
  - `Nickname`
  - `Rooms` (create or join)
  - `Lobby` (invite link and code, the player list, start)
  - `Game` (the table)
- **`Game.tsx`:**
  - Maps each tap to an action (`onCard`, tapping the stock or discard) and works out which cards are tappable (`canTap`).
  - Seats opponents around the table. On large screens with 3+ players they sit left, top and right, clockwise from your left.
  - Turns each opponent's hand to face you (`slotPosition` with `Orient`).
- **`lib/motion.ts`:**
  - When an event arrives, `captureMotion` records the current on-screen position and look of every card involved (before React re-renders).
  - After render, `playMotions` flies two-sided cards from old to new, turning them over mid-air when face-up changes to face-down or back. It also plays swaps with a lift-and-glow phase and peeks (lifted to the peeker; tipped toward them for onlookers), and glides any cards the layout shifted.
  - It respects `prefers-reduced-motion` and skips hidden tabs. A glitch in the animations can never break the table.

## Data flow of one move

1. The player taps the stock. The client emits `game:action { type: 'DRAW_STOCK', expectedVersion }`.
2. The server resolves the session, then `RoomManager.act` runs `applyAction(state, action, Date.now())`.
3. The engine returns the new state plus events: a public `"Ana drew…"` with `motion: stock → held`, and a private `"You drew 7♥"`.
4. The server emits `game:log` to `r:<code>` (public) and `s:<id>` (private). It then emits a `game:view` per player (redacted), reschedules the phase timer, and persists the snapshot.
5. Each client captures the motion on `game:log`, renders the new view, and plays the flight.

## Database

Migrations are in `supabase/migrations`. Row-level security is enabled with **no policies**, so the public Supabase APIs can read nothing. Only the server, through its direct connection string, reads or writes.

| Table | Purpose |
|---|---|
| `guest_sessions` | `id`, `token_hash` (sha256 of the bearer token), `nickname` |
| `rooms` | `code`, `host_session_id`, `status` (lobby/playing/finished/closed), `round_no`, `dealer_index` |
| `room_players` | seat order and `total_score` per room |
| `games` | one row per round: `state_snapshot` (jsonb, the full authoritative state), `version`, `ended_at` |

Live state is kept in memory, and the snapshot is only for recovery. On boot, the server reloads rooms updated in the last day that aren't `closed`, gives players 15s to reconnect before timers resume, and starts their kick timers.
