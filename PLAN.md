# Cabo Online — MVP Plan (functional only)

## Context
The goal is a bare-minimum online version of Cabo: rooms, guest sessions and players, with all the rules from the pasted spec working. It needs no animations, styling or extras, because look and feel come later. The repo `/home/nishit/Work/Github/Cabo` is empty.

**Decisions:**
- **Stack:** TypeScript throughout. The client is React and Vite. The server is Node and Socket.IO.
- **Identity:** guests pick a nickname and get a token.
- **Storage:** Supabase Postgres.
- **Snapping:** as written in the spec.

**Core principle:** the server is authoritative and each client gets only a redacted view, so hidden cards are never sent to a client.

## 0. Game rules (source spec, verbatim)

> # Cabo
>
> **Players:** 2+
> **Type:** Comparing
> **Card rank:** K Q J 10 9 8 7 6 5 4 3 2 A
>
> ## Objective
>
> To be the player with the lowest value of the cards in front of them by either swapping them for lesser value cards or by eliminating cards by pairing them up with cards of equal rank.
>
> ## The Deal
>
> Each player is dealt 4 cards face down from the deck Both Jokers are included. The remainder of the cards are placed face down to form the stockpile. The top card is placed face-up next to the stockpile to form a discard pile. Players arrange their cards into a square formation in front of them. Players my look at the two cards nearest to them ONLY and after memorising their rank must replace them face-down back into the square formation. Once all players have done this, the cards in front of the players may not be looked at until the end of the game or unless a special card allows it. Players should also ensure their cards remain hidden from others.
>
> ## The Play
>
> Beginning with the player to the dealer's left, in clockwise order, players do either of three things:
>
> 1. Pick a card from the *stockpile* and then may
>    1. Keep the card and place one of their own cards on the discard pile
>    2. Discard it
> 2. Pick a card from the *discard* pile and place one of their own cards on the discard pile
> 3. Call cabo
>
> Players should keep all cards except those discarded hidden from the view of other players. If a player calls cabo, the other players each get one more turn and then everyone has to lay down their cards face up. The player with the lowest score wins.
>
> ## Special Cards
>
> If any of the following cards are discarded, the player discarding the card has the option of using the cards ability.
>
> - **Black King:** 'Look & Swap' - Look at another player's card and then choose whether or not swap that card for one of their own.
> - **Queen / Jack:** 'Blind Swap' - The player may swap one of their cards with another player's card but cannot look at it first.
> - **9 / 10:** 'Look at another's' - Look at one of another's players cards.
> - **7 / 8:** 'Look at own' - Look at one of your own cards
>
> ## Snapping
>
> Any time a card is discarded, players may take a card of matching rank from their own set of cards or from another player's hand and lay it on the discard pile. Only the first card layed may remain and hence players must race against each other to be the first to lay a matching card.
>
> If a player incorrectly lays a card (i.e. they thought it was a matching card but remembered incorrectly), they must return the card to its original location and add one card face down in front of them. Conversely if a player successfully matches on of their own cards they may remain with one fewer card for the remainder of the game. If a player matches one of an opponent's card, they can move one of their cards to the newly formed gap in the opponents formation.
>
> ## Scoring
>
> Once all players have turned over their cards, a player's score is determined as follows:
>
> - A = 1
> - 2-10 = Face value
> - J = 11
> - Q = 12
> - Black Kings = 13
> - Red Kings = 0
> - Jokers = -1

## 0b. Ambiguities & loopholes — resolved rulings
The engine enforces these. Each one either fills a gap in the spec or closes an exploit that only exists in the online version.

**Deal & setup**
- **R1:** Seat 0 is the dealer in round 1, and the dealer moves one seat to the left each round. Play starts to the dealer's left.
- **R2:** The 4 cards form a 2×2 grid, and the "two nearest" cards are slots 2 and 3, the bottom row.
  - The server shows them during the peek phase only.
  - After a player clicks Ready, or after 15s, those cards are never sent to that client again.
  - The client must not cache them, and the UI only shows what the server sends.
- **R3:** The discard card turned up at the start of the game is **not** a "discard by a player". It triggers no ability and opens no snap window.
- **R4:** The room holds 2 to 8 players. Dealing 8 players uses 32 cards plus 1, which leaves 21 in stock.

**Turn actions**
- **R5:** `TAKE_DISCARD` requires the player to put the taken card into one of their slots, so it can't be taken and then discarded straight away. A player with 0 cards can't take from the discard.
- **R6:** A player with 0 cards may still `DRAW_STOCK`. They can then only `DISCARD_DRAWN`, because `KEEP` needs a slot.
- **R7:** Abilities trigger **only** on `DISCARD_DRAWN`, meaning a card drawn from stock and discarded immediately.
  - Cards discarded through `KEEP` or `TAKE_DISCARD`, and snapped cards, never trigger abilities.
  - This stops players from "banking" ability cards in their hand.
- **R8:** A red King and Jokers have no ability. Only a **black** King has Look & Swap.
- **R9:** Abilities target only non-empty slots.
  - Black King and 9/10 must target **another** player.
  - 7/8 targets one of the player's own cards.
  - Q/J swaps exactly one of the player's own cards with one of another player's cards. It cannot swap between two opponents.
- **R10:** Black King is a three-step action: `PEEK_OTHER` (another player's card), then `PEEK_OWN` (one of your own), then `SWAP {mySlot}` (swaps exactly those two cards) or `SKIP`. The player sees both cards before deciding.
- **R11:** Swaps are public actions. The log shows *who* swapped *which slots*, but never card values, just as they'd be visible at a real table. A peek is also logged ("Ana looked at Bob's slot 1"); only the peeker sees the value.

**Snapping**
- **R12:** **Sequencing.** A turn runs in this order: action, then ability (if any), then the snap window (3s), then the next turn.
  - Snapping is only possible during the window. This means an ability's target can't vanish halfway through the ability.
  - Every player-made discard opens a window, including discards from `KEEP` and `TAKE_DISCARD`. A successful snap does not open a new window.
- **R13:** Matching is by **rank**. 7 matches 7, any K matches any K, and a Joker matches a Joker.
- **R14:** The window closes on the **first correct** snap, because "only the first card laid may remain".
  - "First" means **fastest reaction**, not first to reach the server. Each client times the window from when it appears on its own screen and reports how long the player took to tap. The server gathers the window's snaps, then replays them in reaction-time order once everyone has reported (a snap, or "no snap" when their window ends) or a 1.5s grace period has passed. A slow connection therefore doesn't lose the race.
  - A reported reaction time is only believed if it's at least 120ms, and it can't be later than the moment the snap reached the server.
  - Each player may snap **once per window**.
  - Correct snaps after the winner's are "too slow". They carry no penalty and reveal nothing. So are snaps timed after the window closed.
- **R15:** A **wrong** snap, meaning a rank mismatch received before any correct snap, works like this:
  - The card is shown to everyone, as it would be when laid on the table.
  - It goes back to its original slot.
  - The snapper gets 1 penalty card from stock, placed face-down in a new slot at the end of their grid. The snapper has not seen it.
  - The window stays open for other players.
  - A player may try more than once, and each wrong snap costs a card, which discourages spamming.
- **R16:** Snapping an empty slot, or a slot that doesn't exist, is rejected as invalid input, with no penalty.
- **R17:** When a player snaps an opponent's card, the gap-fill is **optional**, because the spec says "can move".
  - The snapper gets 15s to send `GIVE_CARD {mySlot}` or `SKIP`. If the timer runs out, it counts as a skip.
  - The card they give goes into the **exact gap**, face-down. Neither the snapper nor the receiver sees it, unless the snapper had already seen it.
  - If the snapper has 0 cards, the gap simply stays.
- **R18:** Gaps (`null`) keep their positions, so other players' memory of slot positions stays valid. Penalty cards are added to the end of the grid and never fill gaps.
- **R19:** The current player may snap too. Once CABO is called, nobody else may snap the caller's cards (R29).

**Cabo & end**
- **R20:** `CALL_CABO` replaces the caller's whole turn, and it is allowed from the first turn onward.
  - Only one Cabo is allowed per round, so nobody can call during the final round.
  - The caller takes no more turns.
  - The caller's cards can no longer be swapped or snapped by anyone else (see R29).
- **R21:** The final round is one turn for each other player, in seat order. The round ends after the last of those turns and its snap window.
- **R22:** Scoring:
  - Only the cards present in a player's grid count; gaps count 0, and a player with 0 cards scores 0.
  - The lowest score wins, and **ties are shared wins**.
  - The spec has no penalty for a caller who didn't have the lowest score, so none is applied.
- **R23:** If stock runs out, shuffle the discard pile, except its top card, back into stock. If there is still nothing to draw or give as a penalty, the round ends immediately and cards are revealed.

**Online-only loopholes**
- **R24:** **Hidden info.** The server never sends a card value to a client that isn't entitled to it (see `view.ts`).
  - Peek and drawn-card values go through `game:private`, to that socket only.
  - Card identities are never sent as stable IDs, so a card can't be tracked through a swap by its ID.
  - Slots are addressed by `(playerId, index)`.
- **R25:** **Stalling.**
  - Each turn has a 60s limit, and an ability or give-card choice has 15s. When time runs out, the server plays for the player: it draws from stock and discards that card, with no ability, or it skips the pending choice.
  - This also covers disconnected players, so one AFK player can't block the table.
  - The peek phase auto-readies after 15s.
- **R26:** **Duplicate or stale actions.**
  - Every action carries `expectedVersion`. If it doesn't match, the action is rejected, which stops double-clicks and replays.
  - Snaps are checked against the window ID instead of the version, so a snap can't be applied to the wrong discard.
- **R27:** **Seat hijack.**
  - A seat is tied to the session token, and the server stores only a sha256 of it.
  - Nobody can join a game that's already running; only the existing seats can reconnect.
  - A new socket for the same session replaces the old one.
- **R29:** **The CABO caller's hand is locked.** Once CABO is called, nobody else may swap with or snap from the caller:
  - A J/Q blind swap can't target the caller. If the caller is the only other player with cards, the J/Q has no usable ability and the snap window opens straight away (as R9).
  - A Black King may still look at one of the caller's cards, but can't swap it; the player can only keep the cards where they are.
  - Nobody else may snap the caller's cards. Such a snap is refused with no penalty and the card isn't revealed (like R16).
  - The caller may still snap their own cards when someone else's discard matches.
- **R30:** **Snap streak.** Whoever makes the first correct snap on a discard then gets a snap window of their own (same length as a normal one):
  - Only they may snap in it, and only cards from their own hand, of the same rank. Each correct snap opens another streak window, so they can clear several matching cards one after another.
  - The window opens whether or not they still hold a match, so it reveals nothing about their hand.
  - A wrong guess costs a penalty card (R15) and ends the streak. They can also stop with **Done**, or let the window run out; then the next turn starts.
  - After snapping an opponent's card, the optional give (R17) comes first, then the streak.
  - Streak snaps aren't raced, so the server applies them as they arrive rather than gathering them for reaction-time ordering (R14).
- **R28:** **Spam.** The server rate-limits each socket, e.g. at most 5 snaps per second. Snaps above that are dropped silently.

## 1. Repo layout (pnpm workspaces)
```
packages/engine/   # pure TS rules: cards.ts, state.ts, reducer.ts, view.ts (+ vitest tests)
apps/server/       # Node + Socket.IO: index.ts, rooms.ts (in-memory RoomManager), db.ts, handlers.ts
apps/web/          # React + Vite, plain HTML/CSS: Home, Lobby, Game pages; socket.ts
supabase/migrations/0001_init.sql
```
The protocol types live in `packages/engine/src/protocol.ts` and are shared by the client and server. There is no separate package for them.

## 2. Data (Supabase Postgres, server-only access, RLS on with no policies)
- `guest_sessions(id, token_hash, nickname, created_at)`
- `rooms(id, code char(6) unique, host_session_id, status lobby|playing|finished, created_at)`
- `room_players(room_id, session_id, seat, total_score)`
- `games(id, room_id, round_no, state_snapshot jsonb, version, started_at, ended_at)`

Live state is kept in memory. After each action, the server upserts the snapshot to `games`. On boot, it rehydrates every room that is `playing`.

## 3. Sessions / rooms / players
- **Guest sessions:**
  - `POST /api/session {nickname}` returns a token.
  - The client keeps the token in localStorage.
  - The socket handshake carries `auth.token`.
- **Rooms:**
  - `room:create` returns a 6-character code.
  - Other players use `room:join {code}`.
  - The host sends `room:start` once there are 2 or more players.
  - The room holds 2 to 8 players.
- **Reconnect:** the same token rejoins the player's seat, and the server resends the full view.
- **Disconnects:** a disconnected player keeps their seat, and the turn timers from R25 auto-play for them. The host can end the room.

## 4. Engine (pure, seeded RNG, fully unit-tested)
**State:**
- The deck is 54 cards, including 2 jokers. There is a stock pile and a discard pile.
- Each player has `slots: (Card|null)[]`, where `null` means an empty gap.
- The state also tracks the turn phase, `caboCalledBy`, `finalTurnsRemaining`, the pending ability or give-card choice, the snap window, and `version`.

**Phases:**
1. **peek:**
   - Each player sees their 2 nearest cards.
   - The phase ends when everyone clicks Ready.
2. **choose.** The player does one of these:
   - `DRAW_STOCK`: go to **drawn**, and only the drawer sees the card.
   - `TAKE_DISCARD {slot}`: swap the top discard into one of their slots.
   - `CALL_CABO`: allowed only at the start of the player's turn.
3. **drawn.** The player does one of these:
   - `KEEP {slot}`: the drawn card replaces a slot, and the old card is discarded.
   - `DISCARD_DRAWN`
4. **ability** (optional, can be skipped). It triggers only when a stock-drawn card is discarded directly.
   - Black King: peek at another player's card, then optionally swap it.
   - Q/J: blind swap.
   - 9/10: peek at another player's card.
   - 7/8: peek at one of their own cards.
5. **snap:** a 3s window opens after the action and any ability resolve. It follows R12–R19:
   - The first correct snap closes the window.
   - Wrong snaps cost a penalty card.
   - After snapping an opponent's card, the snapper can optionally send `GIVE_CARD` into the gap.
   - The next turn starts when the window closes, or once a pending give is resolved.
6. **Cabo:**
   - Every other player gets one more turn.
   - Then all cards are revealed and scored, and the lowest score wins.
   - Each score is added to `total_score`.
   - The host can start the next round.

**Scoring:**
| Card | Points |
|---|---|
| A | 1 |
| 2–10 | face value |
| J | 11 |
| Q | 12 |
| Black K | 13 |
| Red K | 0 |
| Joker | −1 |

**Edge cases:**
- If stock runs out, reshuffle the discard pile (except its top card) into stock.
- A player with 0 cards scores 0.

**Redaction (`view.ts`):**
- Opponents' cards are sent as face-down placeholders.
- A player's own cards are face-down except during their peek or at the reveal.
- The drawn card and peek results go only to the player concerned.

## 5. Socket events
**Client → server:**
- `room:create`
- `room:join`
- `room:start`
- `game:ready`
- `game:action {type,…}`
- `game:snap`

**Server → client:**
- `room:state`
- `game:view`: the full redacted view, re-sent to every player after each action. This is simple and easily fast enough for an MVP.
- `game:private`: peek results and the drawn card.
- `game:log`: text messages, e.g. "Ana snapped a 7".
- `error`

## 6. Web UI (unstyled)
- **Home:** nickname, Create, Join by code.
- **Lobby:** player list and a Start button.
- **Game:**
  - Each player's cards are shown as buttons.
  - Stock and discard are shown as buttons.
  - A text prompt says what to do now.
  - Action buttons are enabled for the current phase.
  - A "Snap" toggle lets the player click any card during the window.
  - A text log shows events.
  - At the end there is a results table.

## 7. Build order
1. Engine plus tests: turn flow, abilities, snapping, Cabo and scoring, redaction.
2. Supabase migration and the server: sessions, rooms, action handlers, snap timer, snapshot and rehydration.
3. Web pages.
4. Playtest.

## 8. Verification
- `pnpm -F engine test`:
  - Scripted games from a seeded deck.
  - Every ability.
  - Snaps: own card, opponent's card, mismatch, and a late snap.
  - Reshuffling the stock.
  - The Cabo final-round turn count.
  - Scoring.
  - A check that no player's view contains cards they aren't allowed to see.
  - At least one named test for each ruling R1–R26 (e.g. `R14: late correct snap rejected without penalty`).
- **Server integration test:**
  - 3 `socket.io-client` bots play a full round against local `supabase start`.
  - A simultaneous-snap test where exactly one snap wins.
  - Restart the server mid-game, then reconnect and confirm the state is restored.
- **Manual check:**
  - Play one game with 3 browser tabs.
  - Inspect the websocket frames to confirm no hidden cards leak.
