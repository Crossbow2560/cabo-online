# Testing

## Running

```bash
npm test                      # engine + server
npm run test -w @cabo/engine  # engine only
npm run test -w @cabo/server  # server integration only
npm run typecheck             # tsc across all workspaces
```

To also run the restart/restore test against a real Postgres (e.g. a throwaway container with the migrations applied):
```bash
TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:54329/postgres npm run test -w @cabo/server
```

CI (`.github/workflows/deploy.yml`) runs `npm ci`, the typecheck, `npm test` and the web build on every push to `main`, before deploying.

## Engine tests (`packages/engine/test/engine.test.ts`, Vitest)

These are unit tests against the pure reducer. Each builds a game with a fixed seed and overrides hands, stock and discard to set up exact situations.
- **Deck and scoring:** 54 cards with 2 Jokers; A=1, J=11, Q=12, black K=13, red K=0, Joker=−1.
- **Rulings R1–R28:** most tests are named after the ruling they cover. For example:
  - `R14: late correct snap rejected without penalty`
  - the R17 give-card tests
  - the R20/R21 Cabo final-round tests
  - R23 reshuffle and deck exhaustion
  - R26 stale versions, with READY exempt
- **Abilities:** peek own, spy, blind swap, and the Black King (theirs → yours → swap/keep). Also: abilities can't target gaps, and they time out.
- **Kicking and leaving (`REMOVE_PLAYER`):**
  - last one standing,
  - turn and dealer repair,
  - a pending give or look being cancelled,
  - Cabo when a player (or the caller) leaves.
- **Motion data:** exact moves for draw/keep, swaps, wrong snaps, peeks, reshuffles and departures.
- **Fuzz test:** 40 seeded games of random legal and illegal actions (including removals). At every step it checks:
  - no view shows a card the viewer isn't entitled to,
  - the total card count stays 54,
  - a card face on a motion only rides along with discard-related moves,
  - peeks never carry a card,
  - the final state renders for every player.

## Server integration tests (`apps/server/test/integration.test.ts`)

These start a real server on a random port (`createCaboServer` with short timings) and drive it with `socket.io-client` bots.
- **Sessions and auth:** invalid tokens are rejected, and `/api/config` returns the right value. A store outage returns 503 / `unavailable` (never 401).
- **Full game:** 3 bots play a whole round ending in Cabo, and the scores match the revealed cards.
- **Races:** two correct snaps sent at the same time give exactly one winner.
- **Rejections:** joining mid-round, and malformed actions.
- **Presence:**
  - auto-kick in the lobby and mid-round (host handover, last one standing, play continuing with 3 players),
  - reconnecting before the deadline,
  - a second tab replacing the first without marking the player offline,
  - the peek phase waiting for a reconnecting player.
- **Stale state:** a kicked player who reconnects gets `room:state null`. Players who leave stop receiving room updates.
- **Server bots:**
  - only the host adds and removes bots, and only between rounds;
  - removing a bot frees its seat;
  - the last human leaving closes the room;
  - a scripted human plays two full rounds against three bots, with card conservation and no refused bot moves.
- **Persistence:** a round in progress survives a server restart, with both `MemoryStore` and (when `TEST_DATABASE_URL` is set) `PgStore`.

## What isn't automated

The web client, including layout and the animation layer, has no automated tests. It was verified manually in a browser. Seed a known deck with `CABO_SEED` to trigger specific abilities on purpose, and measure element positions and animations from the devtools console.

To fill a table while playing yourself, launch browser bots into your room: see [bots](bots.md).
