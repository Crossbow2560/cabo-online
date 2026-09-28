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

## Self-hosting with Docker

One container serves the game server and the built web client on port 3101.

```bash
# on your server, in the repo
cp apps/server/.env.example apps/server/.env   # put your Supabase DATABASE_URL in it
docker compose up -d --build
```

Put it behind your usual reverse proxy for https (e.g. Caddy: `cabo.example.com { reverse_proxy localhost:3101 }`).
WebSockets pass through Caddy/nginx fine; with nginx, forward the `Upgrade`/`Connection` headers.
Update later with `git pull && docker compose up -d --build`, or let CI do it (below).

### Auto-deploy on push (GitHub Actions + self-hosted runner)

`.github/workflows/deploy.yml` runs on every push to `main`: typecheck, tests and a web build on
GitHub's runner, then, if they pass, `docker compose -p cabo up -d --build` on **your server's**
self-hosted runner, and waits for the container to report healthy.

One-time setup:
1. **Server:** install Docker, then add a runner: repo → *Settings → Actions → Runners → New self-hosted
   runner* (Linux) and follow the commands. Install it as a service (`sudo ./svc.sh install && sudo ./svc.sh start`)
   and put the runner's user in the `docker` group (`sudo usermod -aG docker <user>`, then restart the service).
2. **Env file:** after the first deploy run (it will stop at "apps/server/.env is missing"), create
   `apps/server/.env` with `DATABASE_URL=<Supabase session-pooler string>` inside the runner's checkout, e.g.
   `~/actions-runner/_work/cabo-online/cabo-online/apps/server/.env` (`chmod 600`), then re-run the workflow.
   The workflow checks out with `clean: false`, so the file survives later deploys. Re-create it if you
   ever reinstall the runner.
3. Push to `main` (or use *Actions → Test & deploy → Run workflow*).

Keep the self-hosted runner on push-only workflows. If the repo is public, set *Settings → Actions →
Fork pull request workflows* to require approval, so strangers' PRs can't run code on your server.

## Tests

```bash
npm test                                          # engine + server integration
TEST_DATABASE_URL=postgres://... npm test -w @cabo/server   # also runs the restart test against Postgres
```
