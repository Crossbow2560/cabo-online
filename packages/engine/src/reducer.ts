import { abilityOf, buildDeck, cardLabel, cardValue, shuffle, type Card } from './cards';
import {
  DEFAULT_TIMINGS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type Action,
  type ActionError,
  type ActionResult,
  type GameEvent,
  type GameState,
  type Motion,
  type Spot,
  type PlayerState,
  type Timings,
} from './state';

export interface NewGameOptions {
  players: { id: string; name: string }[];
  seed: number;
  dealerIndex: number;
  now: number;
  timings?: Partial<Timings>;
}

export function createGame(opts: NewGameOptions): GameState {
  const n = opts.players.length;
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) throw new Error(`Cabo needs ${MIN_PLAYERS}-${MAX_PLAYERS} players`);
  const [deck, rng] = shuffle(buildDeck(), opts.seed);
  const players: PlayerState[] = opts.players.map((p) => ({ id: p.id, name: p.name, slots: [], ready: false }));
  // Deal one card at a time, starting left of the dealer.
  for (let round = 0; round < 4; round++) {
    for (let k = 1; k <= n; k++) players[(opts.dealerIndex + k) % n].slots.push(deck.pop()!);
  }
  const timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  return {
    players,
    discard: [deck.pop()!], // R3: not a player discard — no ability, no snap window
    stock: deck,
    dealerIndex: opts.dealerIndex % n,
    currentIndex: (opts.dealerIndex + 1) % n,
    phase: { kind: 'peek' },
    deadline: opts.now + timings.peekMs,
    caboCalledBy: null,
    finalTurnsRemaining: 0,
    windowCounter: 0,
    version: 0,
    rng,
    timings,
  };
}

export function scoreOf(player: PlayerState): number {
  return player.slots.reduce((sum, c) => sum + (c ? cardValue(c) : 0), 0);
}

class Reject extends Error {
  constructor(public code: ActionError, message: string) {
    super(message);
  }
}

const reject = (code: ActionError, message: string): never => {
  throw new Reject(code, message);
};

export function applyAction(prev: GameState, action: Action, now: number): ActionResult {
  const s: GameState = structuredClone(prev);
  const events: GameEvent[] = [];
  try {
    if (s.phase.kind === 'ended') reject('wrong_phase', 'The round is over');
    // R26: turn actions must be based on the latest state. READY and SNAP are made by
    // everyone in parallel, so they are exempt (SNAP is checked against its window id).
    const versioned = action.type !== 'TICK' && action.type !== 'SNAP' && action.type !== 'READY' && action.type !== 'REMOVE_PLAYER';
    if (versioned && 'expectedVersion' in action && action.expectedVersion !== undefined && action.expectedVersion !== s.version) {
      reject('stale', 'Game state changed, try again');
    }
    new Ctx(s, events, now).dispatch(action);
    s.version++;
    return { ok: true, state: s, events };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, error: e.code, message: e.message };
    throw e;
  }
}

const slotAt = (playerId: string, slot: number): Spot => ({ at: 'slot', playerId, slot });
const STOCK: Spot = { at: 'stock' };
const DISCARD: Spot = { at: 'discard' };
const held = (playerId: string): Spot => ({ at: 'held', playerId });

class Ctx {
  constructor(private s: GameState, private events: GameEvent[], private now: number) {}

  dispatch(a: Action): void {
    const s = this.s;
    if (a.type === 'TICK') return this.tick();
    if (a.type === 'REMOVE_PLAYER') return this.removePlayer(a.playerId, a.reason);
    const me = this.player(a.playerId);
    switch (a.type) {
      case 'READY': {
        this.expectPhase('peek');
        me.ready = true;
        if (s.players.every((p) => p.ready)) this.startTurns();
        return;
      }
      case 'SNAP':
        return this.snap(me, a.windowId, a.ownerId, a.slot);
    }

    // Everything below is the acting player's own move.
    const phase = s.phase;
    if (phase.kind === 'give') {
      if (me.id !== phase.snapperId) reject('not_your_turn', 'Waiting for the snapper to give a card');
      if (a.type === 'SKIP') return this.log(`${me.name} chose not to give a card`), this.advanceTurn();
      if (a.type !== 'GIVE_CARD') reject('wrong_phase', 'Give a card or skip');
      const g = a as Extract<Action, { type: 'GIVE_CARD' }>;
      const card = this.ownCard(me, g.mySlot);
      const target = this.player(phase.targetId);
      target.slots[phase.slot] = card; // R17: fills the exact gap
      me.slots[g.mySlot] = null;
      this.log(`${me.name} moved their slot ${g.mySlot + 1} into ${target.name}'s slot ${phase.slot + 1}`, {
        moves: [{ from: slotAt(me.id, g.mySlot), to: slotAt(target.id, phase.slot) }],
      });
      return this.advanceTurn();
    }

    if (this.current().id !== me.id) reject('not_your_turn', "It's not your turn");

    switch (a.type) {
      case 'DRAW_STOCK': {
        this.expectPhase('choose');
        const card = this.draw();
        if (!card) return this.endRound('deck_exhausted');
        s.phase = { kind: 'drawn', card };
        this.log(`${me.name} drew from the stockpile`, { moves: [{ from: STOCK, to: held(me.id) }] });
        this.private(me.id, `You drew ${cardLabel(card)}`);
        return;
      }
      case 'TAKE_DISCARD': {
        this.expectPhase('choose');
        const old = this.ownCard(me, a.slot); // R5: must swap into an existing card
        const taken = s.discard.pop()!;
        me.slots[a.slot] = taken;
        s.discard.push(old);
        this.log(`${me.name} took ${cardLabel(taken)} from the discard into slot ${a.slot + 1} and discarded ${cardLabel(old)}`, {
          moves: [
            { from: DISCARD, to: slotAt(me.id, a.slot), card: taken },
            { from: slotAt(me.id, a.slot), to: DISCARD, card: old },
          ],
        });
        return this.openSnapWindow();
      }
      case 'CALL_CABO': {
        this.expectPhase('choose');
        if (s.caboCalledBy) reject('invalid', 'Cabo has already been called'); // R20
        s.caboCalledBy = me.id;
        s.finalTurnsRemaining = s.players.length - 1;
        this.log(`${me.name} called CABO! Everyone else gets one more turn`);
        return this.advanceTurn();
      }
      case 'KEEP': {
        const drawn = this.expectPhase('drawn').card;
        const old = this.ownCard(me, a.slot);
        me.slots[a.slot] = drawn;
        s.discard.push(old);
        this.log(`${me.name} kept the drawn card in slot ${a.slot + 1} and discarded ${cardLabel(old)}`, {
          moves: [
            { from: held(me.id), to: slotAt(me.id, a.slot) },
            { from: slotAt(me.id, a.slot), to: DISCARD, card: old },
          ],
        });
        return this.openSnapWindow();
      }
      case 'DISCARD_DRAWN': {
        const drawn = this.expectPhase('drawn').card;
        s.discard.push(drawn);
        this.log(`${me.name} discarded ${cardLabel(drawn)}`, { moves: [{ from: held(me.id), to: DISCARD, card: drawn }] });
        // R7: abilities only trigger on a stock-drawn card discarded directly.
        const ability = abilityOf(drawn);
        if (ability && this.abilityUsable(me, ability)) {
          s.phase = { kind: 'ability', ability };
          s.deadline = this.now + s.timings.choiceMs;
          return;
        }
        return this.openSnapWindow();
      }
      case 'SKIP': {
        this.expectPhase('ability');
        this.log(`${me.name} skipped the ability`);
        return this.openSnapWindow();
      }
      case 'PEEK_OWN': {
        const ph = this.expectPhase('ability');
        // R10: a Black King also lets you look at one of your own cards, after the other player's.
        const kingStep = ph.ability === 'look_swap' && !!ph.peeked && ph.peekedMine === undefined;
        if (ph.ability !== 'peek_own' && !kingStep) reject('invalid', ph.ability === 'look_swap' ? "Look at another player's card first" : 'Wrong ability');
        const card = this.ownCard(me, a.slot);
        this.log(`${me.name} looked at their own slot ${a.slot + 1}`, { peek: [{ spot: slotAt(me.id, a.slot), by: me.id }] });
        this.private(me.id, `Your slot ${a.slot + 1} is ${cardLabel(card)}`, { playerId: me.id, slot: a.slot, card });
        if (kingStep) {
          ph.peekedMine = a.slot;
          s.deadline = this.now + s.timings.choiceMs;
          return;
        }
        return this.openSnapWindow();
      }
      case 'PEEK_OTHER': {
        const ph = this.expectPhase('ability');
        if (ph.ability !== 'peek_other' && ph.ability !== 'look_swap') reject('invalid', 'Wrong ability');
        if (ph.peeked) reject('invalid', 'Already looked');
        const target = this.other(me, a.targetId);
        const card = this.ownCard(target, a.slot);
        this.log(`${me.name} looked at ${target.name}'s slot ${a.slot + 1}`, { peek: [{ spot: slotAt(target.id, a.slot), by: me.id }] });
        this.private(me.id, `${target.name}'s slot ${a.slot + 1} is ${cardLabel(card)}`, { playerId: target.id, slot: a.slot, card });
        if (ph.ability === 'look_swap' && me.slots.some(Boolean)) {
          ph.peeked = { playerId: target.id, slot: a.slot };
          s.deadline = this.now + s.timings.choiceMs;
          return;
        }
        return this.openSnapWindow();
      }
      case 'SWAP': {
        const ph = this.expectPhase('ability');
        if (ph.ability !== 'look_swap' || !ph.peeked) reject('invalid', 'Look at a card first');
        if (ph.peekedMine === undefined) reject('invalid', 'Look at one of your own cards first');
        if (a.mySlot !== ph.peekedMine) reject('invalid', 'Swap the card you looked at');
        const target = this.player(ph.peeked!.playerId);
        this.swap(me, a.mySlot, target, ph.peeked!.slot);
        return this.openSnapWindow();
      }
      case 'BLIND_SWAP': {
        const ph = this.expectPhase('ability');
        if (ph.ability !== 'blind_swap') reject('invalid', 'Wrong ability');
        this.swap(me, a.mySlot, this.other(me, a.targetId), a.slot);
        return this.openSnapWindow();
      }
      case 'GIVE_CARD':
        return reject('wrong_phase', 'Nothing to give');
      default:
        return reject('invalid', 'Unknown action');
    }
  }

  // ---- snapping (R12–R19) ----

  private snap(snapper: PlayerState, windowId: number, ownerId: string, slot: number): void {
    const s = this.s;
    const ph = s.phase;
    if (ph.kind !== 'snap' || ph.windowId !== windowId || this.now > s.deadline!) {
      reject('too_slow', 'Too slow — the snap window is closed'); // R14
    }
    const owner = this.player(ownerId);
    const card = this.ownCard(owner, slot); // R16: empty / bad slot is invalid, no penalty
    const top = s.discard[s.discard.length - 1];
    const whose = owner.id === snapper.id ? 'their own' : `${owner.name}'s`;

    if (card.rank === top.rank) { // R13
      owner.slots[slot] = null;
      s.discard.push(card);
      this.log(`${snapper.name} snapped ${whose} slot ${slot + 1} (${cardLabel(card)})!`, {
        moves: [{ from: slotAt(owner.id, slot), to: DISCARD, card }],
      });
      if (owner.id !== snapper.id && snapper.slots.some(Boolean)) {
        s.phase = { kind: 'give', snapperId: snapper.id, targetId: owner.id, slot };
        s.deadline = this.now + s.timings.choiceMs;
        return;
      }
      return this.advanceTurn();
    }

    // R15: wrong snap — card is revealed, returned, and the snapper takes a penalty card.
    const penalty = this.draw();
    this.log(`${snapper.name} tried to snap ${whose} slot ${slot + 1} but it was ${cardLabel(card)} — penalty card!`, {
      flash: [{ spot: slotAt(owner.id, slot), card }], // R15: the card is shown to everyone
      moves: penalty ? [{ from: STOCK, to: slotAt(snapper.id, snapper.slots.length) }] : [],
    });
    if (!penalty) return this.endRound('deck_exhausted'); // R23
    snapper.slots.push(penalty); // R18: appended, never fills a gap
  }

  // ---- turn flow ----

  private tick(): void {
    const s = this.s;
    if (s.deadline === null || this.now < s.deadline) reject('not_due', 'Nothing has timed out');
    const ph = s.phase;
    const cur = this.current();
    switch (ph.kind) {
      case 'peek':
        s.players.forEach((p) => (p.ready = true));
        return this.startTurns();
      case 'choose': {
        const card = this.draw();
        if (!card) return this.endRound('deck_exhausted');
        s.discard.push(card);
        this.log(`${cur.name} ran out of time — drew and discarded ${cardLabel(card)}`, { moves: [{ from: STOCK, to: DISCARD, card }] });
        return this.openSnapWindow();
      }
      case 'drawn':
        s.discard.push(ph.card);
        this.log(`${cur.name} ran out of time — discarded ${cardLabel(ph.card)}`, { moves: [{ from: held(cur.id), to: DISCARD, card: ph.card }] });
        return this.openSnapWindow();
      case 'ability':
        this.log(`${cur.name} ran out of time — ability skipped`);
        return this.openSnapWindow();
      case 'snap':
        return this.advanceTurn();
      case 'give':
        this.log(`${this.player(ph.snapperId).name} ran out of time — no card given`);
        return this.advanceTurn();
    }
  }

  private startTurns(): void {
    const s = this.s;
    s.currentIndex = (s.dealerIndex + 1) % s.players.length;
    s.phase = { kind: 'choose' };
    s.deadline = this.now + s.timings.turnMs;
    this.log(`Everyone is ready. ${this.current().name} goes first`);
  }

  private openSnapWindow(): void {
    const s = this.s;
    s.windowCounter++;
    s.phase = { kind: 'snap', windowId: s.windowCounter };
    s.deadline = this.now + s.timings.snapMs;
  }

  private advanceTurn(): void {
    const s = this.s;
    if (s.caboCalledBy) {
      // R21: count the final turns rather than looking for the caller, so it still works if they're kicked.
      if ((s.finalTurnsRemaining ?? 0) <= 0) return this.endRound('cabo');
      s.finalTurnsRemaining--;
    }
    s.currentIndex = (s.currentIndex + 1) % s.players.length;
    s.phase = { kind: 'choose' };
    s.deadline = this.now + s.timings.turnMs;
  }

  /** Left or kicked. Their cards go to the bottom of the stock; turn order is repaired. */
  private removePlayer(id: string, reason = 'left the table'): void {
    const s = this.s;
    const k = s.players.findIndex((p) => p.id === id);
    if (k < 0) reject('invalid', 'Unknown player');
    const [gone] = s.players.splice(k, 1);
    for (const c of gone.slots) if (c) s.stock.unshift(c);
    this.log(`${gone.name} ${reason}`, {
      moves: gone.slots.flatMap((c, i) => (c ? [{ from: slotAt(gone.id, i), to: STOCK }] : [])),
    });

    if (s.players.length < 2) {
      if (s.phase.kind === 'drawn') s.stock.unshift(s.phase.card); // survivor's drawn card isn't lost
      s.currentIndex = 0;
      s.dealerIndex = 0;
      return this.endRound('forfeit');
    }

    const n = s.players.length; // after removal
    const oldN = n + 1;
    const wasCurrent = k === s.currentIndex;
    // Did the removed player still have a final turn coming? Then there's one fewer to wait for.
    if (s.caboCalledBy && !wasCurrent) {
      const dist = (k - s.currentIndex + oldN) % oldN;
      if (dist <= (s.finalTurnsRemaining ?? 0)) s.finalTurnsRemaining--;
    }
    if (k < s.dealerIndex) s.dealerIndex--;
    else if (k === s.dealerIndex) s.dealerIndex = (k - 1 + n) % n;
    if (k < s.currentIndex) s.currentIndex--;

    const ph = s.phase;
    if (ph.kind === 'peek') {
      if (s.players.every((p) => p.ready)) this.startTurns();
      return;
    }
    if (ph.kind === 'ability' && ph.peeked?.playerId === id) {
      return this.openSnapWindow(); // the Black King target is gone — nothing left to swap with
    }
    if (ph.kind === 'give' && (ph.snapperId === id || ph.targetId === id)) {
      if (wasCurrent) s.currentIndex = (k - 1 + n) % n;
      return this.advanceTurn();
    }
    if (wasCurrent) {
      // The player before the gap "just finished", so advancing hands the turn to whoever sat after them.
      s.currentIndex = (k - 1 + n) % n;
      if (ph.kind === 'drawn') s.stock.unshift(ph.card);
      if (ph.kind === 'snap') return; // let the open snap window run out; it then advances normally
      return this.advanceTurn();
    }
  }

  private endRound(reason: 'cabo' | 'deck_exhausted' | 'forfeit'): void {
    const s = this.s;
    const scores: Record<string, number> = {};
    for (const p of s.players) scores[p.id] = scoreOf(p);
    const best = Math.min(...Object.values(scores));
    const winners = s.players.filter((p) => scores[p.id] === best).map((p) => p.id); // R22: ties share
    s.phase = { kind: 'ended', reason, scores, winners };
    s.deadline = null;
    const names = winners.map((id) => this.player(id).name).join(' & ');
    if (reason === 'cabo') this.log(`Round over! Winner: ${names}`);
    else if (reason === 'deck_exhausted') this.log(`No cards left to draw — round over! Winner: ${names}`);
    else this.log(`Round over — ${names} wins as the last one standing`);
  }

  // ---- helpers ----

  /** R23: refill stock from discard (keeping the top card) when empty. */
  private draw(): Card | null {
    const s = this.s;
    if (s.stock.length === 0 && s.discard.length > 1) {
      const top = s.discard.pop()!;
      const [shuffled, rng] = shuffle(s.discard, s.rng);
      s.stock = shuffled;
      s.rng = rng;
      s.discard = [top];
      this.log('The stockpile ran out — the discard pile was reshuffled', {
        moves: Array.from({ length: Math.min(s.stock.length, 6) }, () => ({ from: DISCARD, to: STOCK })),
      });
    }
    return s.stock.pop() ?? null;
  }

  private swap(me: PlayerState, mySlot: number, target: PlayerState, slot: number): void {
    const mine = this.ownCard(me, mySlot);
    const theirs = this.ownCard(target, slot);
    me.slots[mySlot] = theirs;
    target.slots[slot] = mine;
    this.log(`${me.name} swapped their slot ${mySlot + 1} with ${target.name}'s slot ${slot + 1}`, { // R11
      moves: [
        { from: slotAt(me.id, mySlot), to: slotAt(target.id, slot) },
        { from: slotAt(target.id, slot), to: slotAt(me.id, mySlot) },
      ],
    });
  }

  /** R9: whether the discarded ability has any legal target. */
  private abilityUsable(me: PlayerState, ability: string): boolean {
    const mineHas = me.slots.some(Boolean);
    const othersHave = this.s.players.some((p) => p.id !== me.id && p.slots.some(Boolean));
    if (ability === 'peek_own') return mineHas;
    if (ability === 'blind_swap') return mineHas && othersHave;
    return othersHave;
  }

  private expectPhase<K extends GameState['phase']['kind']>(kind: K): Extract<GameState['phase'], { kind: K }> {
    if (this.s.phase.kind !== kind) reject('wrong_phase', `Not allowed right now (${this.s.phase.kind})`);
    return this.s.phase as Extract<GameState['phase'], { kind: K }>;
  }

  private current(): PlayerState {
    return this.s.players[this.s.currentIndex];
  }

  private player(id: string): PlayerState {
    return this.s.players.find((p) => p.id === id) ?? reject('invalid', 'Unknown player');
  }

  private other(me: PlayerState, id: string): PlayerState {
    if (id === me.id) reject('invalid', 'Pick another player');
    return this.player(id);
  }

  private ownCard(p: PlayerState, slot: number): Card {
    if (!Number.isInteger(slot) || slot < 0 || slot >= p.slots.length) reject('invalid', 'No such slot');
    return p.slots[slot] ?? reject('invalid', 'That slot is empty');
  }

  private log(text: string, motion?: Motion): void {
    this.events.push(motion ? { text, motion } : { text });
  }

  private private(to: string, text: string, reveal?: GameEvent['reveal']): void {
    this.events.push(reveal ? { to, text, reveal } : { to, text });
  }
}
