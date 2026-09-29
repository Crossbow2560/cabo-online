# Structure

```
.
├── packages/
│   └── engine/                  @cabo/engine: rules, no I/O
│       ├── src/
│       │   ├── cards.ts         Card/Rank/Suit, scoring, abilities, deck, seeded shuffle, labels
│       │   ├── state.ts         GameState, Phase union, Action union, Motion/Spot, timings, events
│       │   ├── reducer.ts       createGame, applyAction (all rules R1–R28), scoreOf
│       │   ├── view.ts          redactFor: the only state → client projection
│       │   ├── protocol.ts      Socket.IO event types, ClientAction, RoomState
│       │   └── index.ts
│       └── test/engine.test.ts  rule tests + fuzz tests (redaction, card conservation, motion leaks)
├── apps/
│   ├── server/                  @cabo/server
│   │   ├── src/
│   │   │   ├── main.ts          entry: loads apps/server/.env, picks the store, reads PORT/PUBLIC_URL/CABO_SEED
│   │   │   ├── server.ts        Express routes, Socket.IO auth + handlers, input shape checks
│   │   │   ├── rooms.ts         RoomManager/Room: lifecycle, timers, kick, peek hold, fan-out, restore
│   │   │   └── store.ts         Store interface, PgStore (postgres.js), MemoryStore
│   │   ├── test/integration.test.ts   socket.io-client bots against a real server
│   │   └── .env.example
│   └── web/                     @cabo/web
│       ├── index.html           fonts (Alfa Slab One, Nunito)
│       ├── vite.config.ts       dev proxy: /api and /socket.io → :3101
│       └── src/
│           ├── App.tsx          screen state machine, session bootstrap, socket wiring
│           ├── Game.tsx         the table: seating, tap handling, prompt, piles, results
│           ├── theme.css        palette tokens, components, responsive layout, animations
│           ├── screens/         Landing, Nickname, Rooms, Lobby
│           ├── components/      PlayingCard, Hand, Seat, ActionBar, EventFeed, PlayersCard,
│           │                    RoundResults, RulesModal, ConfirmDialog, CopyField,
│           │                    DesertBackdrop, Title, Icon
│           ├── lib/             motion.ts (card animations), copy.ts (clipboard), config.ts
│           │                    (PUBLIC_URL), useNow.ts, useMediaQuery.ts
│           └── assets/icons/    game-icons.net SVGs (CC BY 3.0), fill = currentColor
├── tools/browser-bot.js         in-page bot that joins a room and plays via the UI (docs/bots.md)
├── supabase/migrations/         0001_init.sql (schema + RLS), 0002_fk_indexes.sql
├── .github/workflows/deploy.yml test on GitHub runner, deploy on self-hosted runner
├── Dockerfile                   multi-stage: build web, run server with tsx
├── docker-compose.yml           single service, port 3101, env from apps/server/.env
├── PLAN.md                      original rules text + engine rulings R1–R28
└── package.json                 npm workspaces (packages/*, apps/*)
```

## Responsibilities and boundaries

- **`packages/engine`:**
  - Must stay pure: no `Date.now()` (the clock is an argument), no `Math.random()` (the RNG state lives in `GameState.rng`), no network, no DOM.
  - Every rule change goes here, with a test.
  - The engine is also the **contract**: the server and web import its types (`Action`, `PlayerView`, `ClientAction`, `RoomState`), so protocol drift is a compile error.
- **`apps/server`:**
  - Does not implement game rules. It validates the *shape* of input, then trusts the engine's accept/reject.
  - Owns everything time- or connection-related: phase timers, kicks, the peek hold, and "one socket per session".
- **`apps/web`:**
  - Renders only what the server sends. It must not cache hidden cards (e.g. peek results) beyond what the UI shows right now.
  - The `revealed` map in `Game.tsx` exists only to keep a Black King's two looked-at cards face-up while deciding.
  - Animation code lives in `lib/motion.ts`. Components only tag cards with `data-spot` / `data-seat` anchors.
- **`tools/browser-bot.js`:** plain browser JS with no build step. It depends on the web client's DOM hooks (`data-spot`, `.pcard--*` classes, button labels), so keep it in step when those change.
- **`supabase/migrations`:** schema only. The server doesn't run migrations; apply them through the Supabase SQL editor or CLI.

## Workspaces

Packages reference each other as `@cabo/engine: "*"`, and TypeScript sources are consumed directly (`main: src/index.ts`), with no build step:
- Vite compiles the web client.
- `tsx` runs the server.
- Vitest runs the tests.
