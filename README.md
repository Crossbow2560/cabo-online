# Cabo (online MVP)

Bare-bones multiplayer Cabo: guest sessions, rooms with invite codes, and the full rule set with server-authoritative, redacted game state. See [PLAN.md](PLAN.md) for the rules and rulings R1–R28.

```
packages/engine   pure rules engine (reducer, redaction, scoring) + tests
apps/server       Node + Socket.IO + Postgres (Supabase) persistence
apps/web          React + Vite client (unstyled)
supabase/migrations/0001_init.sql
```

## Run locally

```bash
npm install
npm run dev:server   # :3101 — in-memory storage unless DATABASE_URL is set
npm run dev:web      # :5173 — proxies /api and /socket.io to :3101
```

Open http://localhost:5173, pick a nickname, create a room, and share the invite link. To test with several players on one machine, use separate browser profiles or private windows, because the session token lives in localStorage.

## Supabase

The project `fpcmlrpvtwarhivkuwwz` already has the migrations in `supabase/migrations/` applied.

1. Copy `apps/server/.env.example` to `apps/server/.env`.
2. Paste the **Session pooler** connection string (Dashboard → Connect) as `DATABASE_URL`, with your DB password filled in.
3. Restart the server. It logs `restored N room(s)` instead of the in-memory warning.

Only the server talks to the database. RLS is on with no policies, so the public Supabase APIs can't read game state.

## Production-ish

```bash
npm run build -w @cabo/web
DATABASE_URL=... npm start -w @cabo/server   # also serves apps/web/dist
```

## Tests

```bash
npm test                                          # engine + server integration
TEST_DATABASE_URL=postgres://... npm test -w @cabo/server   # also runs the restart test against Postgres
```
