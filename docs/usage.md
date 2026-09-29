# Usage guide

## Starting a game

1. Open the site and choose **Play now**, then enter a nickname. Your identity is saved in this browser, so reloading keeps your seat.
2. Choose **Create room**. The lobby shows an **invite link** and a **room code**, each with a Copy button.
3. Friends open the link, which goes straight to the **Join Room** page with the code filled in, or tap **Join room** and type the code there.
4. The host presses **Start game** once there are 2–8 players. Short of players? The host can press **+ Add bot** in the lobby and pick a level: Beginner, Novice, Intermediate or Expert (**✕** removes one). Bots play at a human pace from only what their seat can see. See [bots](bots.md).

**Watching:** tap **Spectate** (the third tile, beside Create room and Join room), enter the code and press **Watch** to follow a game without a seat, even one already under way. You see the table as it plays out with every hand face-down (no one's cards, not even a drawn one), plus the log and the scores. **Stop watching** takes you back. Players see how many are watching (👁) in the lobby. If a watcher's connection drops they keep their place for a minute, so a reload goes straight back to the table.

The same browser profile is always the same player. To test alone, use private windows or different browsers, or add `?profile=<name>` to the URL (e.g. `/?room=ABC123&profile=p2`), which keeps a separate player per name in one browser. To play against bots, see [bots](bots.md).

## Playing a round

- **Peek (20s):** your two nearest cards (bottom row, #3 and #4) are shown face-up. Memorise them, then press **I've memorised them**. Afterwards you can't look at your cards unless an ability lets you.
- **Opening snap:** once everyone has memorised, there's a snap window on the card turned up at the deal, before the first turn. Anyone can snap cards that match it.
- **Your turn:**
  - **Tap the stock** to draw. The card appears under "You drew". Then **tap one of your cards** to keep the new card (the old one goes to the discard), or press **Discard it**.
  - **Tap the discard** to take it, then tap one of your cards to swap with it. Tap the discard again to cancel.
  - **Call CABO**, the only button. Everyone else gets one final turn (a "Final round" tag appears), then all cards are revealed.
- **Abilities:** these trigger only when you discard a card you just drew. A badge on the discard names the ability in play.

  | Card | Ability |
  |---|---|
  | 7 / 8 | **Peek at yours:** tap one of your cards to see it. |
  | 9 / 10 | **Spy:** tap an opponent's card to see it. |
  | J / Q | **Blind swap:** tap one of your cards, then an opponent's. |
  | Black K | **Look & swap:** tap an opponent's card; it's shown to you and put back. Then tap one of yours; same again. Each step waits for the card to be back. Then, with every card back face-down, pick the swap: the two cards you looked at are selected, but you can tap any card of yours and any other player's card instead. Press **Swap**, or **Keep them** to swap nothing. |

  Once someone calls CABO, their hand is locked: a J/Q can't blind swap with them, a Black King can look at their card but not swap with them, and nobody else can snap their cards (the caller can still snap their own).

  **Skip ability** is always available. After a peek or a swap, snapping opens only once the cards are back in place (about 6s after a peek, 2s after a swap), so you can snap the very card you just looked at. The peeked card lifts toward you for a few seconds; other players see which card you looked at, but not its value.
- **Snapping:** after any discard there's a 3.5s **SNAP!** window. Tap any card, yours or an opponent's, that you think matches the discard's rank.
  - You get **one** snap per window. Your 3.5s start when the window appears on *your* screen.
  - The fastest correct snap wins: snaps are compared by how quickly each player reacted, so a laggy connection doesn't cost you the race. The result shows once everyone's window has ended.
  - Slower correct snaps are "too slow", with no penalty.
  - **Snap streak:** whoever snaps first then gets a 3.5s window of their own to snap more cards of the same rank from their own hand, one after another (say you hold two Aces and an Ace is discarded: snap one, then the other). It opens even if you have no match left, so nobody can tell. A wrong guess costs a penalty card and ends the streak; **Done** stops it early.
  - A wrong guess shows the card to everyone, puts it back, and gives you a face-down penalty card.
  - If you snapped an opponent's card, you may tap one of yours to give them, or press **Don't give a card**.
- **Scoring:**

  | Card | Points |
  |---|---|
  | Joker | −1 |
  | Red King | 0 |
  | Ace | 1 |
  | 2–10 | face value |
  | Jack | 11 |
  | Queen | 12 |
  | Black King | 13 |

  Gaps count 0. The lowest total wins the round, and ties share the win. Running totals are shown in the results and in the **Posse** card.

## The table

- Your hand is at the bottom, numbered #1–#4. Penalty cards are added as #5, #6 and so on in extra columns.
- Opponents' hands are turned to face you: a player across the table shows their `1 2 / 3 4` as `4 3 / 2 1`. On large screens with 3+ players they sit left, top and right, clockwise from your left. Players on the left and right have their cards turned sideways, facing them. Phones keep everyone on top.
- Every card movement is animated, and the card that just changed glows for a moment. Swaps lift and glow both cards before they cross.
- **Posse** (bottom-left) shows online status, away countdowns and totals. **Log** (bottom-right) shows the full event history, and messages marked "just you" are private. **?** opens the rules.

## Sound

The speaker button (in the table's top bar between pause and **?**, and in the lobby's top-right corner) opens the sound settings: **Master**, **Game** and **Music** volumes, and **Mute all**. Settings are saved in this browser.
- Game sounds follow the cards: a shuffle when a round is dealt, a slide when a card is drawn, a soft place when a card lands, a shove when two cards swap or a wrong snap is pushed back, and a fan when a card is lifted to be looked at. There's also a short chip click when your turn starts, a clatter when someone calls CABO, and a fan as the round's cards are revealed.
- **Music:** a background tune loops in the lobby and at the table, carrying on seamlessly when the game starts. The **Music** slider sets its volume (0 turns it off). It pauses while the tab is in the background and stops when you leave the room.
- Browsers only allow sound after you've tapped or pressed a key on the page, so the first few moments may be silent. Sounds are skipped while the tab is in the background.

## Pausing and ending a game

- **Pause (❚❚ in the top bar):** anyone can pause a round, and anyone can press **Resume**. While paused, the turn timers stop, bots wait, and no moves are accepted. On resume, everyone gets back exactly the time they had left. You can't pause during a 3.5s snap window: each player's window runs on their own screen, so it can't be frozen fairly.
- **End game:** when a round ends, the host sees **End game** next to **Start next round**. After a confirmation, everyone sees the final totals (lowest wins), and the room goes back to the lobby with totals reset, ready for a new game.

## Leaving, disconnects and timeouts

- **Leave game** (with confirmation) works at any time. Mid-round, your cards go back to the stock; if only one player is left, they win ("last one standing").
- **If you disconnect:**
  - You keep your seat, and others see an "away" countdown.
  - After 5 minutes offline you're removed automatically.
  - Reconnecting within that time cancels the countdown.
  - At the start of a round, the peek phase waits (up to 60s) for offline players.
- **Timeouts:**
  - If you take longer than 60s on a turn, the game draws and discards for you.
  - If you take longer than 15s on an ability or give choice, it's skipped.

## Common problems

| Symptom | Cause / fix |
|---|---|
| "Opened elsewhere" | The same player is open in another tab. Press **Use it here**, or close the other tab. |
| "A round is in progress" when joining | New players can join only in the lobby or between rounds. Wait for the round to end. |
| "Game state changed, try again" | The screen was a step behind (e.g. a double tap). Just act again. |
| "Too slow — the snap window is closed" | Someone else snapped first, or the 3.5s window ended. No penalty. |
| Stuck on "Saddling up…" | The client is waiting for the server. It retries automatically, so check the server is running and reachable. |
| Invite link shows the wrong address | Set `PUBLIC_URL` on the server (see [installation](installation.md)). |
