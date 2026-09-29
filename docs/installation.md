# Installation

## Prerequisites

- **Node.js 24** (the Docker image and CI use 24; anything ≥ 22 works) and **npm**.
- Optional: a **Supabase** project (or any Postgres) for persistence. Without it, the server keeps everything in memory.
- Optional, for production: **Docker** with the Compose plugin, and a reverse proxy or tunnel that passes WebSockets.

## Local development

1. Clone and install:
   ```bash
   git clone https://github.com/Crossbow2560/cabo-online.git
   cd cabo-online
   npm install
   ```
2. Environment (optional). Create `apps/server/.env`; `main.ts` loads it automatically:
   ```bash
   cp apps/server/.env.example apps/server/.env
   ```

   | Variable | Default | Meaning |
   |---|---|---|
   | `DATABASE_URL` | unset → in-memory | Postgres connection string. For Supabase use the **Session pooler** URI (IPv4-friendly). A transaction pooler on port 6543 also works; prepared statements are disabled automatically. |
   | `PUBLIC_URL` | unset → the page's own address | Address players use, e.g. `https://cabo.nishit-db.com`. Only used for invite links. Don't set it locally. |
   | `PORT` | `3101` | HTTP and Socket.IO port. |
   | `CABO_SEED` | unset | **Testing only.** Deals every round from a fixed seed. The server prints a warning when it's set. Never set it in production. |

3. Database (only when using `DATABASE_URL`). Apply the migrations once, in the Supabase SQL editor or with the CLI:
   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql -f supabase/migrations/0002_fk_indexes.sql
   ```
4. Run it in two terminals:
   ```bash
   npm run dev:server
   ```
   ```bash
   npm run dev:web
   ```
   - The server listens on http://localhost:3101 (`tsx watch`, restarting on changes).
   - Vite serves http://localhost:5173 and proxies `/api` and `/socket.io` to `:3101`.

## Verify it works

```bash
curl -s -X POST localhost:3101/api/session -H 'content-type: application/json' -d '{"nickname":"Ana"}'
```
You should get `{"sessionId":"…","nickname":"Ana","token":"…"}`. Then:
- Open http://localhost:5173 and create a room.
- Open the invite link in a private window, join, and start a round.
- If `DATABASE_URL` is set, the server logs `restored N room(s)` on restart instead of the in-memory warning.

## Production (Docker)

One container serves the built web client, the API and the sockets on port 3101:
```bash
docker compose up -d --build
```
`docker-compose.yml` reads `apps/server/.env`; `.dockerignore` keeps every `.env` out of the image.

Put it behind HTTPS with WebSockets passed through:
- **Caddy:** `cabo.example.com { reverse_proxy localhost:3101 }`
- **nginx:** `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`
- **Cloudflare Tunnel:** `service: http://127.0.0.1:3101`. No CORS headers are needed, because everything is same-origin.

### Push-to-deploy (GitHub Actions + self-hosted runner)

`.github/workflows/deploy.yml` runs on every push to `main`:
1. On GitHub's runner: `npm ci`, typecheck, tests and the web build.
2. On your server's self-hosted runner: `docker compose -p cabo up -d --build`, then it waits for the container healthcheck.

One-time setup:
1. Install Docker on the server.
2. Register a self-hosted runner (repo → Settings → Actions → Runners), install it as a service, and add its user to the `docker` group.
3. Push once, and let it fail at "apps/server/.env is missing".
4. Create `apps/server/.env` (with `DATABASE_URL` and `PUBLIC_URL`) inside the runner's checkout, e.g. `~/actions-runner/_work/cabo-online/cabo-online/apps/server/.env`. The checkout uses `clean: false`, so the file survives deploys.
5. Re-run the workflow.

If the repository is public, set "Fork pull request workflows" to require approval, because a self-hosted runner executes code on your machine.
