# Cabo

A real-time multiplayer web version of **Cabo**, the memory card game where the lowest hand wins. Wild-west themed, playable in the browser on desktop, tablet and phone.

## 📚 Documentation
| | |
|---|---|
| [⚙️ Architecture](docs/architecture.md) | System design, components and flow |
| [📁 Structure](docs/structure.md) | Project organization and responsibilities |
| [🚀 Installation](docs/installation.md) | Requirements and steps to run the project |
| [🧠 Technical decisions](docs/decisions.md) | Trade-offs and design justifications |
| [📖 Usage guide](docs/usage.md) | How to play, flows and edge cases |
| [🔌 API](docs/api.md) | HTTP endpoints and Socket.IO events |
| [🧪 Testing](docs/testing.md) | How to run tests and what they cover |
| [🤖 Bots](docs/bots.md) | Lobby bots (server-side) and browser bots for playing against a real human |

The full rule set and every ruling the engine enforces (R1–R28) live in [PLAN.md](PLAN.md).

---

## Description

- **What it does:** lets 2–8 players create a room, share an invite link, and play Cabo in real time. That covers the peek at your two nearest cards, drawing, swapping, the special-card abilities (7/8 peek, 9/10 spy, J/Q blind swap, black King look & swap), snapping matching cards, and calling CABO for the final round.
- **What problem it solves:** Cabo depends on hidden information and on races (snapping). Played online, the server has to be the only source of truth. It never sends a player a card they aren't entitled to see, and it decides snap races in arrival order.
- **Real use case:** a group of friends open `https://cabo.nishit-db.com/?room=ABC123` on their phones and play a few rounds. Running totals are kept per room. Players who drop off are auto-removed after 5 minutes, and a server restart restores games in progress from Postgres.

## Quick start

```bash
npm install
npm run dev:server   # game server on http://localhost:3101 (in-memory storage)
npm run dev:web      # Vite dev server on http://localhost:5173
```

Open http://localhost:5173, pick a nickname, create a room, and open the invite link in a **private window** to add a second player (each browser profile is one player).

## Technologies used

- **Game engine:** pure TypeScript with a seeded RNG, and no I/O (`packages/engine`).
- **Server:** Node 24, Express 4, Socket.IO 4, run directly from TypeScript with `tsx`.
- **Client:** React 18, Vite 5, and plain CSS. There is no router or state library. Card animations use the Web Animations API.
- **Database:** Supabase Postgres, accessed through `postgres` (postgres.js), with an in-memory fallback.
- **Testing:** Vitest, with `socket.io-client` bots for the integration tests.
- **Deployment:** Docker (a single container) and a GitHub Actions workflow that deploys through a self-hosted runner.

## Quick installation

1. `npm install`
2. Optional: create `apps/server/.env` with `DATABASE_URL` (Supabase session pooler) and `PUBLIC_URL`.
3. Run `npm run dev:server` and `npm run dev:web`, or `docker compose up -d --build` for production.

Details: [docs/installation.md](docs/installation.md)

## Architecture (summary)

A pure rules engine (`packages/engine`) turns `(state, action, now)` into a new state plus events. The Node server owns one authoritative state per room, applies player actions strictly in arrival order, and sends each player a **redacted view** (`redactFor`) plus public and private events. The React client renders only what it receives and animates card movement from the `motion` data attached to events. Postgres stores sessions, rooms and a snapshot of each game after every action. More: [docs/architecture.md](docs/architecture.md)

## Project structure

```
packages/engine/   rules engine, redaction, protocol types (+ tests)
apps/server/       Express + Socket.IO game server, room manager, Postgres store (+ tests)
apps/web/          React client: screens, table, card animations, theme
supabase/          SQL migrations
.github/workflows/ test + deploy pipeline
tools/            browser-bot.js: in-page bot for playtesting against humans
Dockerfile, docker-compose.yml
```

More: [docs/structure.md](docs/structure.md)
