# Bots: playtesting with a human in the loop

There are two kinds of bot:

| | Server bots | Browser bots |
|---|---|---|
| How to add | Host presses **+ Add bot** in the lobby | An agent (or you) opens a tab per bot and runs [`tools/browser-bot.js`](../tools/browser-bot.js) |
| Runs in | The game server (`apps/server/src/bot.ts`) | A browser tab, clicking the real UI |
| Needs | Nothing | One tab per bot, kept open |
| Strategy | Tracks every card it has seen (its own and opponents'); snaps and blind-swaps opponents' cards | Tracks only its own cards; never blind-swaps or snaps opponents |
| Good for | Filling a table, playing solo, testing rules | Exercising the real client (sockets, rendering, animations) |

## Server bots (lobby button)

In the lobby, the host sees **+ Add bot** next to **Leave room**, and a **✕** on each bot's row.
- Bots are named `Dusty (bot)`, `Calamity (bot)`, … and show **Bot** as their status.
- Only the host can add or remove them, and never mid-round (the server refuses with "Wait for the round to end"). The limit is the usual 8 seats.
- Bots never host. When the last human leaves, the room closes and its bots go with it.
- Bots are always online, so they're never auto-kicked and never hold up the peek phase.

**Fair play:** a bot decides from `redactFor(state, botId)`, the same redacted view a client gets. It also sees the events that seat would receive: public ones plus its own private peek results. It never reads the full game state.

**Card memory** (`BotBrain` in `apps/server/src/bot.ts`):
- It follows every card `motion` in the event stream: keeps, takes, swaps, gives, snaps and penalty cards. So it knows where each card it has seen went, including cards moved to or from opponents' hands.
- It also records wrong-snap reveals, its peek results and whatever is face-up to it.
- Memory resets each round.

**How it plays:**

| Situation | Move |
|---|---|
| Peek | **Ready** after 2–4s. |
| Its turn | Calls CABO when every card is known and the total is ≤ 6, or after 12 turns with an estimated total ≤ 14 (unknown cards count 6.5). Otherwise it takes a discard worth ≤ 3 if it improves its hand; if not, it draws. |
| Drew a card | Keeps it over its worst known card if lower, or in an unknown slot if the card is worth ≤ 5. Otherwise it discards it, which triggers any ability. |
| 7 / 8 | Peeks at an unknown card of its own. |
| 9 / 10 | Spies an unknown opponent card. |
| J / Q | Blind-swaps its worst known card for a known opponent card at least 3 points lower. If its worst card is ≥ 10, it gambles on an unknown opponent card instead. Otherwise it skips. |
| Black K | Looks at an opponent card, then its own worst card, and swaps if theirs is lower. |
| Snap window | Snaps any remembered card (its own first, else an opponent's) matching the discard, after 0.8–1.6s. |
| Snapped an opponent's card | Gives its worst known card (if worth ≥ 5), else an unknown one. |

Other moves wait 0.9–2s, so a human can follow along and win snap races. `botPace` in `ServerOptions` scales every delay; the tests use `0.005`.

If the engine refuses a move (e.g. the table changed first), the bot falls back to the plainest legal move: discard, draw or skip. Refusals other than stale-version or too-slow are recorded in `RoomManager.botRejections`, and the integration test asserts that list stays empty.

**Persistence:** each bot gets a `guest_sessions` row whose `token_hash` is `bot:<id>`. That value is never a sha256, so no client can sign in as a bot. `PgStore` uses the prefix to recognise bots when restoring rooms after a restart; the restored bots resume with empty memory. No migration is needed.

## Browser bots (`tools/browser-bot.js`)

A **browser bot** is an ordinary browser tab running the script. It signs in with a nickname, joins a room code, and plays by clicking the real UI, the same buttons and cards a person uses.
- It goes through the real client, sockets, server and animations, so it tests what players actually get.
- It only knows what that seat can see: its own face-up cards during the peek, its drawn card, and its "just you" peek results.

Use it when you want the whole client exercised: *"Put 2 browser bots in room `ABC123`."*

### Quick recipe (for an agent)

**Input:** a room code (e.g. `4WVSXG`), a bot count N, and the site's base URL. The base URL is `http://localhost:5173` for dev, or e.g. `https://cabo.nishit-db.com`.

The human creates the room and shares the code. They stay the host, so they decide when to **Start game** and **Start next round**.

For each bot `k = 1..N`:

1. **Open a separate identity.** Open a new browser tab at:
   ```
   <BASE>/?room=<CODE>&profile=bot<k>
   ```
   `?profile=` gives the tab its own saved player (localStorage key `cabo.token.bot<k>`). Several bots can therefore share one browser and one origin (see [Identities](#identities)).
2. **Load the bot script** into the tab. Paste the whole content of `tools/browser-bot.js` into the page's JavaScript context (devtools console, or a "run JavaScript in page" tool).
   - In dev only, you can load it from Vite instead of pasting:
     ```js
     (0, eval)(await (await fetch('/@fs/<abs-path-to-repo>/tools/browser-bot.js')).text())
     ```
   - Use `fetch` + `eval`, not `import()`. Vite reloads any page that imported the file whenever it changes, which kills the bot.
3. **Start it** with a unique name:
   ```js
   caboBot({ name: 'Bot Ana', room: '<CODE>' })
   ```
   The bot clicks **Play now**, enters its nickname, and joins the room. The human's lobby shows it within a second or two.

Then tell the human the bots are seated and they can press **Start game**.

**Checking on a bot:** run this in its tab to get its screen, prompt, the cards it remembers, and its last moves:
```js
__caboBot.status()
// { name, screen: 'game', prompt: "Bot Cody's turn", known: { '#1': 'K', '#3': '9' }, turns: 3,
//   recent: ['11:08:21 AM draw', '11:08:22 AM keep K in #1', …] }
```
The console also logs every move as `[bot <name>] …`.

**Stopping:** run `__caboBot.stop()`, or close the tab. A closed bot shows as "away" and is auto-kicked after 5 minutes. If that leaves fewer than 2 players, the human wins "last one standing". For a clean exit, stop the bot, then press **Leave game** in its tab.

#### With the Claude desktop Browser pane

These are the calls actually used to verify this document, for 2 bots in room `4WVSXG`:

```
tabs_create                                   → tab-3
tabs_create                                   → tab-4
navigate  tab-3  http://localhost:5173/?room=4WVSXG&profile=bot1
navigate  tab-4  http://localhost:5173/?room=4WVSXG&profile=bot2
javascript_tool tab-3:  <browser-bot.js>; caboBot({ name: 'Bot Ana',  room: '4WVSXG' })
javascript_tool tab-4:  <browser-bot.js>; caboBot({ name: 'Bot Cody', room: '4WVSXG' })
```
Background tabs keep playing; nothing needs to be in front.
- Poll with `javascript_tool` → `__caboBot.status()`.
- Keep each call under the tool's ~45s limit. Wait in short slices rather than one long loop.
- When done, run `__caboBot.stop()` and `tabs_close` for each bot tab.

### Options

```js
caboBot({
  name: 'Bot Ana',          // nickname; keep it unique in the room (memory tracking matches on it)
  room: 'ABC123',           // room code to join; omit if the tab is already seated
  think: [700, 1800],       // ms pause before each move, so the human can follow along
  snap: true,               // snap its own cards that match the discard
  snapDelay: [600, 1400],   // snap reaction time; lower = harder for the human to win races
  caboAt: 8,                // call CABO once every card is known and the total ≤ this
  caboAfterTurns: 12,       // …or after this many of its own turns, so rounds always end
})
```

Calling `caboBot()` again in the same tab replaces the running bot (for example, to change options mid-game). The bot's card memory resets when it does.

### How a bot plays

The bot is a simple, legal, human-paced strategy. It is not an optimal player.

| Situation | What it does |
|---|---|
| Peek phase | Reads its two face-up cards, waits 1.5–3s, presses **I've memorised them**. |
| Its turn | Calls **CABO** if the total of its known cards is ≤ `caboAt` (unknown cards count as 99), or after `caboAfterTurns` turns. Otherwise it takes the discard when it's worth ≤3 and improves its hand; failing that, it taps the stock. |
| Drew a card | Keeps it in place of its worst known card if lower, or in an unknown slot if the card is worth ≤4. Otherwise it presses **Discard it**. |
| 7 / 8 | Peeks at an unknown card of its own, and learns it from the "Your slot N is …" toast. |
| 9 / 10 | Looks at a random opponent card. The result isn't used. |
| J / Q | **Skip ability.** It never blind-swaps. |
| Black K | Looks at a random opponent card, then at its own worst known card. It swaps if theirs is lower, otherwise **Keep them**. |
| Snap window | Snaps its own card if it remembers one with the discard's rank, after `snapDelay`. It never snaps opponents' cards. |
| Snapped someone's card | **Don't give a card.** |
| Round over | Waits. The host (the human) starts the next round, and the bot re-memorises. |

**Card memory** is updated from what the seat sees:
- face-up own cards;
- private peek toasts;
- its own keeps and takes;
- public log lines:
  - `… with <name>'s slot N` or `… into <name>'s slot N` → forget that slot;
  - `tried to snap <name>'s slot N but it was X` → learn it.

### Identities

A player's identity is a bearer token in the page's `localStorage`. Two tabs with the same token are the **same player**, and the second shows "Opened elsewhere". Give every bot its own identity, in any of these ways:

| Way | Works on | Notes |
|---|---|---|
| `?profile=<name>` | Any deployment | Recommended. Keeps separate tokens per profile on one origin (`App.tsx`, `PROFILE`). The tab keeps the parameter in its URL, so reloads stay the same player. |
| Different origins | Local | e.g. `localhost:5173`, `[::1]:5173`, `localhost:3101`, `127.0.0.1:3101`, `[::1]:3101`. Each origin has its own storage. Port 3101 serves the built client (`npm run build -w @cabo/web`) and needs no Vite. |
| Separate browser profiles / private windows | Any | Useful when driving real browsers by hand. |

Don't reuse a profile name for two live tabs. The humans' own tabs have no `profile`, so they use the normal `cabo.token` and never collide with bots.

### Gotchas

- **Only the host can start.** Bots never press **Start game** or **Start next round**. If a bot ends up as host (the human left), start rounds from its tab by hand.
- **New players can join only in the lobby or between rounds.** Mid-round, a bot's join fails with "A round is in progress". Launch bots before the human presses Start, or during the results screen.
- **Background timers.** Browsers slow timers in hidden tabs. The bot is driven by DOM changes as well as a 1s poll, so it keeps up. If a hidden tab is ever throttled hard, its turns are auto-played after the 60s turn timeout instead of stalling the game.
- **Animations** are skipped in hidden tabs (`document.hidden`), so bots in background tabs move instantly. The human's own tab still animates everything the bots do.
- **UI coupling.** The bot finds things by DOM hooks and button text:
  - `.prompt-strip`, `.mine`, `[data-spot="stock"|"discard"|"slot:<id>:<i>"]`, `.pcard--selectable` / `--face` / `--gap` / `--selected`, `.pile--drawn`, `.ability-badge`, `.snap-banner`, `.toast`, `.tbar__round`;
  - buttons: "Play now", "Join room", "I've memorised them", "Discard it", "Skip ability", "Swap them" / "Keep them", "Call CABO", "Don't give a card".

  If you rename any of these, update `tools/browser-bot.js` too.
- **Deterministic deals:** start the server with `CABO_SEED` (the `server-seeded` launch config) to replay a known deal while testing with bots. Never set it in production.

## Headless alternative

For load or regression runs without a browser, drive the server directly with `socket.io-client`, the way `apps/server/test/integration.test.ts` does (`bot()`, `lobby()`, `startAndReady()`, see [API](api.md)). Its "server-side bots" tests also play whole rounds of one scripted human against three server bots.
