# Analytics (Umami)

Cabo can report visits and game events to a self-hosted [Umami](https://umami.is), a cookie-free
analytics tool. It is **off by default**: the game loads nothing until the server is told where
Umami lives.

## Run Umami

Umami and its own Postgres run as two extra services in `docker-compose.yml`, behind the
`analytics` profile, so a plain `docker compose up` (and the deploy workflow) never starts them.

1. Create the secrets file (gitignored):

   ```bash
   cp umami.env.example umami.env
   ```

   Replace every `change-me` with a random value (`openssl rand -hex 24`; for
   `TWO_FACTOR_ENCRYPTION_KEY` use `openssl rand -hex 32`). The password in `DATABASE_URL` must
   match `POSTGRES_PASSWORD`.

2. Start it:

   ```bash
   docker compose --profile analytics up -d umami
   ```

3. Open the dashboard at <http://localhost:3200>. Sign in with Umami's default account
   (`admin` / `umami`) and **change the password straight away** (Settings → Profile).

4. Settings → Websites → **Add website** (name `Cabo`, domain e.g. `cabo.nishit-db.com`), then
   copy its **Website ID**.

## Point the game at it

Set both in `apps/server/.env` (the server hands them to the client via `/api/config`, so no
rebuild is needed) and restart the server:

```bash
UMAMI_SCRIPT_URL=http://localhost:3200/script.js
UMAMI_WEBSITE_ID=<the website ID>
```

With either one unset, analytics stays off. The script URL must be reachable **from the players'
browsers**: `localhost:3200` only works on this machine. For real players, put Umami behind a
public address (e.g. `https://stats.nishit-db.com` via the same reverse proxy as the game) and use
that address here.

## What is recorded

Umami counts page views, visitors, countries, browsers and devices by itself. The client
(`apps/web/src/lib/analytics.ts`, called from `App.tsx`) adds these events:

| Event | When | Data |
|---|---|---|
| `room_created` | a player creates a room | |
| `room_joined` | a player joins with a code | `invite`: came from an invite link |
| `room_spectated` | someone starts watching | |
| `bot_added` | the host adds a bot | `level` |
| `game_started` | the host deals the first round | `players`, `bots` |
| `round_started` | the host deals a later round | `players`, `bots` |
| `game_finished` | the game ends (sent once, by the host) | `rounds`, `players`, `reason` |

No nicknames, room codes or other personal data are sent. Ad-blockers may block the script; the
game works the same either way.

## Production (self-hosted runner)

Do these once on the server, inside the runner's checkout
(e.g. `~/actions-runner/_work/cabo-online/cabo-online`, the folder that holds `apps/server/.env`).
The deploy uses `clean: false`, so untracked files there survive every deploy.

1. Merge/deploy the commit that adds analytics, so the checkout has the new `docker-compose.yml`.
2. Create `umami.env` with fresh random secrets (see "Run Umami" above).
3. Make every deploy keep Umami running: create a `.env` **in the checkout root** (Compose reads
   it automatically; it's gitignored) containing

   ```bash
   COMPOSE_PROFILES=analytics
   ```

4. Start it: `docker compose -p cabo up -d umami` (the same project name as the deploy).
5. Give it a public HTTPS address on the reverse proxy, pointing at `127.0.0.1:3200`
   (Caddy: `stats.example.com { reverse_proxy localhost:3200 }`; Cloudflare Tunnel:
   `service: http://127.0.0.1:3200`). The port is bound to localhost only, so the proxy is the
   only way in.
6. Open the dashboard there, change the `admin` password, add the website, copy its ID.
7. Add `UMAMI_SCRIPT_URL=https://stats.example.com/script.js` and `UMAMI_WEBSITE_ID=…` to
   `apps/server/.env`, then `docker compose -p cabo up -d cabo` (recreating the container picks up
   the new env).

Back up Umami's data with
`docker compose -p cabo exec umami-db pg_dump -U umami umami > umami-$(date +%F).sql`.
