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
   | `TRUST_PROXY` | unset | `1` behind a reverse proxy or tunnel: rate limits key on the client IP from `CF-Connecting-IP` / `X-Forwarded-For` instead of the proxy's. Only set it if port 3101 isn't reachable directly, or clients could fake their IP. |
   | `PORT` | `3101` | HTTP and Socket.IO port. |
   | `CABO_SEED` | unset | **Testing only.** Deals every round from a fixed seed. The server prints a warning when it's set. Never set it in production. |
   | `UMAMI_SCRIPT_URL`, `UMAMI_WEBSITE_ID` | unset → no analytics | Optional self-hosted Umami. Both must be set; see [analytics](analytics.md). |

   The web dev server reads one variable of its own: `CABO_SERVER` (default `http://localhost:3101`), the server Vite proxies to. Use it to point the client at a second server, e.g. an in-memory one on another port.

3. Database (only when using `DATABASE_URL`). Apply the migrations once, in the Supabase SQL editor or with the CLI:
   ```bash
   psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql -f supabase/migrations/0002_fk_indexes.sql -f supabase/migrations/0003_room_settings.sql -f supabase/migrations/0004_clamp_nicknames.sql
   ```
   On an existing database, apply only the ones it doesn't have yet. `0004` trims nicknames saved before the 8-character limit; the server also trims them on read, so it's tidy-up rather than required.
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

With any of these, set `TRUST_PROXY=1` so rate limits see each player's IP (otherwise every player shares the proxy's). Without it, all players count against one IP's budget.

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

### Custom domain and SEO

The production origin `https://cabo.nishit-db.com` is hardcoded in the static SEO files, because they're served as-is and can't read `PUBLIC_URL`. If you deploy on another domain, update it in:
- `apps/web/index.html`: the canonical link, the Open Graph/Twitter tags and the JSON-LD block
- `apps/web/public/robots.txt`: the `Sitemap:` line
- `apps/web/public/sitemap.xml`

The text inside `<div id="root">` in `index.html` is a crawlable description of the game. React replaces it on mount, so players never see it. `apps/web/public/og-image.png` (1200×630) is the link-preview image.
