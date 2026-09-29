import { describe, expect, it } from 'vitest';
import {
  applyAction,
  buildDeck,
  cardValue,
  createGame,
  redactFor,
  scoreOf,
  type Action,
  type Card,
  type GameState,
} from '../src';

const c = (spec: string): Card => {
  if (spec === 'JOKER') return { rank: 'JOKER', suit: null };
  return { rank: spec.slice(0, -1) as Card['rank'], suit: spec.slice(-1) as Card['suit'] };
};

const T0 = 1_000_000;

function game(n = 3, dealerIndex = 0): GameState {
  return createGame({
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
    seed: 42,
    dealerIndex,
    now: T0,
  });
}

/** Game past the peek phase, with p1 to play (dealer p0). Optionally override hands/piles. */
function playing(opts: { hands?: string[][]; stock?: string[]; discard?: string[]; n?: number } = {}): GameState {
  let s = game(opts.n ?? 3);
  for (const p of s.players) s = ok(s, { type: 'READY', playerId: p.id });
  if (opts.hands) opts.hands.forEach((h, i) => (s.players[i].slots = h.map((x) => (x === '-' ? null : c(x)))));
  if (opts.stock) s.stock = opts.stock.map(c); // last element = top
  if (opts.discard) s.discard = opts.discard.map(c);
  return s;
}

function ok(s: GameState, a: Action, now = T0) {
  const r = applyAction(s, a, now);
  if (!r.ok) throw new Error(`${a.type} failed: ${r.error} ${r.message}`);
  return r.state;
}

function run(s: GameState, a: Action, now = T0) {
  return applyAction(s, a, now);
}

function err(s: GameState, a: Action, now = T0) {
  const r = applyAction(s, a, now);
  if (r.ok) throw new Error(`${a.type} unexpectedly succeeded`);
  return r.error;
}

const HANDS = [
  ['2S', '3S', '4S', '5S'],
  ['7H', '8H', '9H', '10H'],
  ['JC', 'QC', 'KC', 'KH'],
];

describe('deck & scoring', () => {
  it('has 54 cards incl. 2 jokers', () => {
    const d = buildDeck();
    expect(d).toHaveLength(54);
    expect(d.filter((x) => x.rank === 'JOKER')).toHaveLength(2);
  });

  it('scores per spec', () => {
    expect(cardValue(c('AS'))).toBe(1);
    expect(cardValue(c('7D'))).toBe(7);
    expect(cardValue(c('10H'))).toBe(10);
    expect(cardValue(c('JH'))).toBe(11);
    expect(cardValue(c('QS'))).toBe(12);
    expect(cardValue(c('KS'))).toBe(13);
    expect(cardValue(c('KC'))).toBe(13);
    expect(cardValue(c('KH'))).toBe(0);
    expect(cardValue(c('KD'))).toBe(0);
    expect(cardValue(c('JOKER'))).toBe(-1);
  });
});

describe('deal & peek', () => {
  it('R1: deals 4 each, play starts left of dealer, dealer rotates by dealerIndex', () => {
    const s = game(3, 1);
    expect(s.players.every((p) => p.slots.length === 4)).toBe(true);
    expect(s.stock.length + s.discard.length).toBe(54 - 12);
    let t = s;
    for (const p of t.players) t = ok(t, { type: 'READY', playerId: p.id });
    expect(t.players[t.currentIndex].id).toBe('p2');
  });

  it('R2: only the two nearest own cards are visible during peek, and never after ready', () => {
    let s = game();
    let v = redactFor(s, 'p1');
    const mine = v.players.find((p) => p.id === 'p1')!;
    expect(mine.slots.map((x) => x!.card !== null)).toEqual([false, false, true, true]);
    for (const p of v.players.filter((p) => p.id !== 'p1')) expect(p.slots.every((x) => x!.card === null)).toBe(true);
    s = ok(s, { type: 'READY', playerId: 'p1' });
    v = redactFor(s, 'p1');
    expect(v.players.find((p) => p.id === 'p1')!.slots.every((x) => x!.card === null)).toBe(true);
  });

  it('a spectator (not seated) sees no card at all until the reveal, not even a drawn one', () => {
    let s = game();
    const hidden = (v: ReturnType<typeof redactFor>) => v.players.every((p) => p.slots.every((x) => !x || x.card === null)) && v.drawnCard === null;
    expect(hidden(redactFor(s, 'spectator'))).toBe(true); // peek phase: nobody's cards
    for (const p of s.players) s = ok(s, { type: 'READY', playerId: p.id });
    const cur = s.players[s.currentIndex].id;
    s = ok(s, { type: 'DRAW_STOCK', playerId: cur });
    expect(redactFor(s, cur).drawnCard).not.toBeNull();
    expect(hidden(redactFor(s, 'spectator'))).toBe(true);
  });

  it('R26: READY is not version-checked (players ready up concurrently)', () => {
    let s = game();
    const v0 = s.version;
    s = ok(s, { type: 'READY', playerId: 'p0', expectedVersion: v0 });
    s = ok(s, { type: 'READY', playerId: 'p1', expectedVersion: v0 });
    expect(s.players[1].ready).toBe(true);
  });

  it('R2/R25: peek phase auto-readies after timeout', () => {
    const s = game();
    expect(err(s, { type: 'TICK' }, T0 + 1)).toBe('not_due');
    const t = ok(s, { type: 'TICK' }, T0 + s.timings.peekMs);
    expect(t.phase.kind).toBe('choose');
  });

  it('R3: initial discard opens no snap window', () => {
    const s = playing();
    expect(s.phase.kind).toBe('choose');
    expect(s.windowCounter).toBe(0);
  });

  it('R4: 2..8 players', () => {
    expect(() => game(1)).toThrow();
    expect(() => game(9)).toThrow();
    const s = game(8);
    expect(s.stock.length).toBe(21);
  });
});

describe('turn actions', () => {
  it('draw + keep swaps into slot and discards old card, then opens snap window', () => {
    let s = playing({ hands: HANDS, stock: ['AS'], discard: ['6D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    expect(redactFor(s, 'p1').drawnCard).toEqual(c('AS'));
    expect(redactFor(s, 'p2').drawnCard).toBeNull();
    s = ok(s, { type: 'KEEP', playerId: 'p1', slot: 0 });
    expect(s.players[1].slots[0]).toEqual(c('AS'));
    expect(s.discard.at(-1)).toEqual(c('7H'));
    expect(s.phase.kind).toBe('snap');
  });

  it('R7: KEEP-discarding a special card does not trigger an ability', () => {
    let s = playing({ hands: HANDS, stock: ['AS'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'KEEP', playerId: 'p1', slot: 1 }); // discards 8H
    expect(s.phase.kind).toBe('snap');
  });

  it('R5: take discard must replace an existing card', () => {
    let s = playing({ hands: [HANDS[0], ['-', '8H', '9H', '10H'], HANDS[2]], discard: ['AD'] });
    expect(err(s, { type: 'TAKE_DISCARD', playerId: 'p1', slot: 0 })).toBe('invalid');
    s = ok(s, { type: 'TAKE_DISCARD', playerId: 'p1', slot: 1 });
    expect(s.players[1].slots[1]).toEqual(c('AD'));
    expect(s.discard.at(-1)).toEqual(c('8H'));
    expect(s.phase.kind).toBe('snap');
  });

  it('R6: a player with no cards can draw but only discard', () => {
    let s = playing({ hands: [HANDS[0], ['-', '-'], HANDS[2]], stock: ['5D'] });
    expect(err(s, { type: 'TAKE_DISCARD', playerId: 'p1', slot: 0 })).toBe('invalid');
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    expect(err(s, { type: 'KEEP', playerId: 'p1', slot: 0 })).toBe('invalid');
    ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
  });

  it('rejects out-of-turn actions and R26 stale versions', () => {
    const s = playing();
    expect(err(s, { type: 'DRAW_STOCK', playerId: 'p2' })).toBe('not_your_turn');
    expect(err(s, { type: 'DRAW_STOCK', playerId: 'p1', expectedVersion: s.version - 1 })).toBe('stale');
    ok(s, { type: 'DRAW_STOCK', playerId: 'p1', expectedVersion: s.version });
  });
});

describe('abilities', () => {
  const drawAndDiscard = (card: string, extra: Partial<Parameters<typeof playing>[0]> = {}) => {
    let s = playing({ hands: HANDS, stock: [card], ...extra });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    return ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
  };

  it('7/8: peek own (private event only)', () => {
    const s = drawAndDiscard('7S');
    expect(s.phase).toMatchObject({ kind: 'ability', ability: 'peek_own' });
    expect(err(s, { type: 'PEEK_OTHER', playerId: 'p1', targetId: 'p2', slot: 0 })).toBe('invalid');
    const r = run(s, { type: 'PEEK_OWN', playerId: 'p1', slot: 2 });
    if (!r.ok) throw new Error();
    const priv = r.events.filter((e) => e.to);
    expect(priv).toEqual([{ to: 'p1', text: 'Your slot 3 is 9♥', reveal: { playerId: 'p1', slot: 2, card: c('9H') } }]);
    expect(r.events.filter((e) => !e.to).every((e) => !e.reveal)).toBe(true);
    expect(r.events.filter((e) => !e.to).some((e) => e.text.includes('9♥'))).toBe(false);
    expect(r.state.phase.kind).toBe('snap');
  });

  it('9/10: peek another player (R9: not self)', () => {
    const s = drawAndDiscard('10S');
    expect(err(s, { type: 'PEEK_OTHER', playerId: 'p1', targetId: 'p1', slot: 0 })).toBe('invalid');
    const r = run(s, { type: 'PEEK_OTHER', playerId: 'p1', targetId: 'p2', slot: 1 });
    if (!r.ok) throw new Error();
    expect(r.events.find((e) => e.to)?.text).toContain('Q♣');
    expect(r.events.find((e) => e.to)?.reveal).toEqual({ playerId: 'p2', slot: 1, card: c('QC') });
    expect(r.events.filter((e) => !e.to).every((e) => !e.reveal)).toBe(true);
  });

  it('J/Q: blind swap between me and another player', () => {
    let s = drawAndDiscard('QD');
    expect(err(s, { type: 'BLIND_SWAP', playerId: 'p1', mySlot: 0, targetId: 'p1', slot: 1 })).toBe('invalid');
    s = ok(s, { type: 'BLIND_SWAP', playerId: 'p1', mySlot: 0, targetId: 'p2', slot: 2 });
    expect(s.players[1].slots[0]).toEqual(c('KC'));
    expect(s.players[2].slots[2]).toEqual(c('7H'));
  });

  it('R8/R10: black king = look at theirs, look at yours, then optional swap; red king has no ability', () => {
    let s = drawAndDiscard('KS');
    expect(err(s, { type: 'SWAP', playerId: 'p1', mySlot: 0 })).toBe('invalid');
    expect(err(s, { type: 'PEEK_OWN', playerId: 'p1', slot: 3 })).toBe('invalid'); // theirs first
    s = ok(s, { type: 'PEEK_OTHER', playerId: 'p1', targetId: 'p0', slot: 0 });
    expect(s.phase).toMatchObject({ kind: 'ability', peeked: { playerId: 'p0', slot: 0 } });
    expect(err(s, { type: 'SWAP', playerId: 'p1', mySlot: 3 })).toBe('invalid'); // must look at own first
    const r = run(s, { type: 'PEEK_OWN', playerId: 'p1', slot: 3 });
    if (!r.ok) throw new Error(r.message);
    expect(r.events.find((e) => e.to)?.reveal).toEqual({ playerId: 'p1', slot: 3, card: c('10H') });
    s = r.state;
    expect(s.phase).toMatchObject({ kind: 'ability', peekedMine: 3 });
    expect(redactFor(s, 'p2').abilityPeekedMine).toBe(3);
    expect(err(s, { type: 'SWAP', playerId: 'p1', mySlot: 1 })).toBe('invalid'); // only the card you looked at
    s = ok(s, { type: 'SWAP', playerId: 'p1', mySlot: 3 });
    expect(s.players[1].slots[3]).toEqual(c('2S'));
    expect(s.players[0].slots[0]).toEqual(c('10H'));

    const red = drawAndDiscard('KD');
    expect(red.phase.kind).toBe('snap');
    const joker = drawAndDiscard('JOKER');
    expect(joker.phase.kind).toBe('snap');
  });

  it('black king: can decline the swap after looking at both', () => {
    let s = drawAndDiscard('KC');
    s = ok(s, { type: 'PEEK_OTHER', playerId: 'p1', targetId: 'p0', slot: 0 });
    s = ok(s, { type: 'PEEK_OWN', playerId: 'p1', slot: 1 });
    s = ok(s, { type: 'SKIP', playerId: 'p1' });
    expect(s.phase.kind).toBe('snap');
    expect(s.players[0].slots[0]).toEqual(c('2S'));
  });

  it('R9: abilities cannot target gaps', () => {
    const s = drawAndDiscard('9S', { hands: [['-', '3S'], HANDS[1], HANDS[2]] });
    expect(err(s, { type: 'PEEK_OTHER', playerId: 'p1', targetId: 'p0', slot: 0 })).toBe('invalid');
  });

  it('R25: ability times out into the snap window', () => {
    const s = drawAndDiscard('8S');
    const t = ok(s, { type: 'TICK' }, T0 + s.timings.choiceMs);
    expect(t.phase.kind).toBe('snap');
  });
});

describe('snapping', () => {
  /** p1 discards 5D, opening a snap window. p0 holds 5S in slot 3. */
  const withWindow = () => {
    let s = playing({ hands: HANDS, stock: ['5D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    expect(s.phase.kind).toBe('snap');
    return s;
  };
  const wid = (s: GameState) => (s.phase as { windowId: number }).windowId;

  it('R13: own-card snap removes the card and leaves a gap (R18); after the streak window the turn advances', () => {
    let s = withWindow();
    s = ok(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p0', slot: 3 });
    expect(s.players[0].slots).toEqual([c('2S'), c('3S'), c('4S'), null]);
    expect(s.discard.at(-1)).toEqual(c('5S'));
    expect(s.phase).toMatchObject({ kind: 'snap', onlyFor: 'p0' }); // R30
    s = ok(s, { type: 'TICK' }, T0 + s.timings.snapMs);
    expect(s.phase.kind).toBe('choose');
    expect(s.players[s.currentIndex].id).toBe('p2');
  });

  it('R14: second snap on the same discard is too slow, no penalty', () => {
    let s = withWindow();
    const w = wid(s);
    s = ok(s, { type: 'SNAP', playerId: 'p0', windowId: w, ownerId: 'p0', slot: 3 });
    const before = s.players[2].slots.length;
    expect(err(s, { type: 'SNAP', playerId: 'p2', windowId: w, ownerId: 'p0', slot: 2 })).toBe('too_slow');
    expect(s.players[2].slots.length).toBe(before);
  });

  it('a snap replayed after the deadline counts if it happened (`at`) inside the window', () => {
    const s = withWindow();
    const late = T0 + s.timings.snapMs + 400;
    const t = ok(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p0', slot: 3, at: T0 + 500 }, late);
    expect(t.players[0].slots[3]).toBeNull();
    expect(err(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p0', slot: 3, at: T0 + s.timings.snapMs + 1 }, late)).toBe('too_slow');
  });

  it('R14: snap after the window deadline is too slow', () => {
    const s = withWindow();
    expect(err(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p0', slot: 3 }, T0 + s.timings.snapMs + 1)).toBe('too_slow');
  });

  it('R15: wrong snap reveals publicly, returns card, adds unseen penalty card; window stays open', () => {
    const s = withWindow();
    const r = run(s, { type: 'SNAP', playerId: 'p2', windowId: wid(s), ownerId: 'p2', slot: 0 });
    if (!r.ok) throw new Error();
    const t = r.state;
    expect(t.players[2].slots).toHaveLength(5);
    expect(t.players[2].slots[0]).toEqual(c('JC'));
    expect(redactFor(t, 'p2').players[2].slots[4]!.card).toBeNull();
    expect(r.events.some((e) => !e.to && e.text.includes('J♣'))).toBe(true);
    expect(t.phase.kind).toBe('snap');
    // someone else can still snap correctly
    const u = ok(t, { type: 'SNAP', playerId: 'p0', windowId: wid(t), ownerId: 'p0', slot: 3 });
    expect(u.players[0].slots[3]).toBeNull();
  });

  it('R16: snapping a gap or bad slot is invalid, no penalty', () => {
    let s = withWindow();
    s = { ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, slots: [null, ...p.slots.slice(1)] } : p)) };
    expect(err(s, { type: 'SNAP', playerId: 'p2', windowId: wid(s), ownerId: 'p0', slot: 0 })).toBe('invalid');
    expect(err(s, { type: 'SNAP', playerId: 'p2', windowId: wid(s), ownerId: 'p0', slot: 9 })).toBe('invalid');
  });

  it('R17: snapping an opponent card lets snapper give a card into the exact gap', () => {
    let s = withWindow();
    s = ok(s, { type: 'SNAP', playerId: 'p2', windowId: wid(s), ownerId: 'p0', slot: 3 });
    expect(s.phase).toMatchObject({ kind: 'give', snapperId: 'p2', targetId: 'p0', slot: 3 });
    expect(err(s, { type: 'GIVE_CARD', playerId: 'p0', mySlot: 0 })).toBe('not_your_turn');
    s = ok(s, { type: 'GIVE_CARD', playerId: 'p2', mySlot: 2 });
    expect(s.players[0].slots[3]).toEqual(c('KC'));
    expect(s.players[2].slots[2]).toBeNull();
    expect(s.phase).toMatchObject({ kind: 'snap', onlyFor: 'p2' }); // R30: then the snapper's streak
  });

  it('R17: give is optional (skip or timeout)', () => {
    let s = withWindow();
    s = ok(s, { type: 'SNAP', playerId: 'p2', windowId: wid(s), ownerId: 'p0', slot: 3 });
    const skipped = ok(s, { type: 'SKIP', playerId: 'p2' });
    expect(skipped.players[0].slots[3]).toBeNull();
    expect(skipped.phase).toMatchObject({ kind: 'snap', onlyFor: 'p2' });
    const timed = ok(s, { type: 'TICK' }, T0 + s.timings.choiceMs);
    expect(timed.phase).toMatchObject({ kind: 'snap', onlyFor: 'p2' });
  });

  it('R17: snapper with no cards skips give', () => {
    let s = playing({ hands: [HANDS[0], HANDS[1], ['-']], stock: ['5D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    s = ok(s, { type: 'SNAP', playerId: 'p2', windowId: wid(s), ownerId: 'p0', slot: 3 });
    expect(s.phase).toMatchObject({ kind: 'snap', onlyFor: 'p2' }); // no give; straight to the streak
  });

  it('R30: the first snapper gets a snap streak for their own cards only', () => {
    // p0 holds two 5s; p1 discards a 5.
    let s = playing({ hands: [['5S', '3S', '5C', '4S'], HANDS[1], ['5H', '8C', '9C', 'QC']], stock: ['5D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    s = ok(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p0', slot: 0 });
    expect(s.phase).toMatchObject({ kind: 'snap', onlyFor: 'p0' });
    expect(redactFor(s, 'p2').snapOnlyFor).toBe('p0');
    // Nobody else may snap in it, and p0 can't reach into someone else's hand.
    expect(err(s, { type: 'SNAP', playerId: 'p2', windowId: wid(s), ownerId: 'p2', slot: 0 })).toBe('too_slow');
    expect(err(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p2', slot: 0 })).toBe('invalid');
    // Another 5 of theirs: gone, and the streak goes on.
    s = ok(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p0', slot: 2 });
    expect(s.players[0].slots).toEqual([null, c('3S'), null, c('4S')]);
    expect(s.phase).toMatchObject({ kind: 'snap', onlyFor: 'p0' });
    // Done: the turn moves on.
    const done = ok(s, { type: 'SKIP', playerId: 'p0' });
    expect(done.phase.kind).toBe('choose');
    expect(done.players[done.currentIndex].id).toBe('p2');
    // A wrong guess instead: penalty card, streak over.
    const miss = ok(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p0', slot: 1 });
    expect(miss.players[0].slots).toHaveLength(5);
    expect(miss.phase.kind).toBe('choose');
  });

  it('R30: the streak window opens even with no matching card left (it reveals nothing)', () => {
    let s = withWindow();
    s = ok(s, { type: 'SNAP', playerId: 'p0', windowId: wid(s), ownerId: 'p0', slot: 3 });
    expect(s.phase).toMatchObject({ kind: 'snap', onlyFor: 'p0' });
    expect(ok(s, { type: 'TICK' }, T0 + s.timings.snapMs).phase.kind).toBe('choose');
  });

  it('R13: kings match kings, jokers match jokers', () => {
    let s = playing({ hands: [['JOKER'], ['KH', 'AS'], HANDS[2]], stock: ['KS'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' }); // black king ability
    s = ok(s, { type: 'SKIP', playerId: 'p1' });
    s = ok(s, { type: 'SNAP', playerId: 'p1', windowId: wid(s), ownerId: 'p1', slot: 0 });
    expect(s.players[1].slots[0]).toBeNull();
  });

  it('R12: no snapping during the ability, KEEP and TAKE_DISCARD open windows', () => {
    let s = playing({ hands: HANDS, stock: ['7S'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    expect(err(s, { type: 'SNAP', playerId: 'p1', windowId: s.windowCounter, ownerId: 'p1', slot: 0 })).toBe('too_slow');
  });

  it('R19: the current player may snap', () => {
    let s = playing({ hands: [HANDS[0], ['5H', '8H'], HANDS[2]], stock: ['5D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    s = ok(s, { type: 'SNAP', playerId: 'p1', windowId: wid(s), ownerId: 'p1', slot: 0 });
    expect(s.players[1].slots[0]).toBeNull();
  });

  it('snap window timeout advances the turn', () => {
    const s = withWindow();
    const t = ok(s, { type: 'TICK' }, T0 + s.timings.snapMs);
    expect(t.players[t.currentIndex].id).toBe('p2');
  });
});

describe('cabo & end of round', () => {
  it("R29: nobody can swap with the CABO caller (J/Q or Black King), but may still look and snap", () => {
    // p1 calls CABO; p2 plays next and discards a Queen.
    let s = playing({ hands: HANDS, stock: ['QD'] });
    s = ok(s, { type: 'CALL_CABO', playerId: 'p1' });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p2' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p2' });
    expect(s.phase).toMatchObject({ kind: 'ability', ability: 'blind_swap' });
    expect(err(s, { type: 'BLIND_SWAP', playerId: 'p2', mySlot: 0, targetId: 'p1', slot: 0 })).toBe('invalid');
    const q = ok(s, { type: 'BLIND_SWAP', playerId: 'p2', mySlot: 0, targetId: 'p0', slot: 0 });
    expect(q.players[1].slots).toEqual(s.players[1].slots); // caller untouched

    // Black King: looking at the caller's card is fine, swapping it is not.
    let k = playing({ hands: HANDS, stock: ['KS'] });
    k = ok(k, { type: 'CALL_CABO', playerId: 'p1' });
    k = ok(k, { type: 'DRAW_STOCK', playerId: 'p2' });
    k = ok(k, { type: 'DISCARD_DRAWN', playerId: 'p2' });
    k = ok(k, { type: 'PEEK_OTHER', playerId: 'p2', targetId: 'p1', slot: 0 });
    k = ok(k, { type: 'PEEK_OWN', playerId: 'p2', slot: 0 });
    expect(err(k, { type: 'SWAP', playerId: 'p2', mySlot: 0 })).toBe('invalid');
    expect(ok(k, { type: 'SKIP', playerId: 'p2' }).phase.kind).toBe('snap');
  });

  it("R29: a J/Q has no ability when the CABO caller is the only one to swap with", () => {
    let s = playing({ n: 2, hands: [['AS', '5S'], ['2S', '3S']], stock: ['JD'] });
    s = ok(s, { type: 'CALL_CABO', playerId: 'p1' });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p0' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p0' });
    expect(s.phase.kind).toBe('snap');
  });

  it('R20/R21: others each get exactly one more turn, then reveal & score', () => {
    let s = playing({ hands: [['AS'], ['2S'], ['JOKER', 'KH']] });
    s = ok(s, { type: 'CALL_CABO', playerId: 'p1' });
    expect(err(s, { type: 'CALL_CABO', playerId: 'p2' })).toBe('invalid');
    expect(s.players[s.currentIndex].id).toBe('p2');
    s = ok(s, { type: 'TICK' }, T0 + s.timings.turnMs); // p2 auto-plays
    s = ok(s, { type: 'TICK' }, T0 + s.timings.turnMs + s.timings.snapMs); // window closes
    expect(s.players[s.currentIndex].id).toBe('p0');
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p0' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p0' });
    if (s.phase.kind === 'ability') s = ok(s, { type: 'SKIP', playerId: 'p0' });
    s = ok(s, { type: 'TICK' }, T0 + s.timings.snapMs);
    expect(s.phase.kind).toBe('ended');
    const v = redactFor(s, 'p0');
    expect(v.players[2].slots.every((x) => x!.card !== null)).toBe(true); // everything revealed
    expect(v.result!.scores).toEqual({ p0: 1, p1: 2, p2: -1 });
    expect(v.result!.winners).toEqual(['p2']);
  });

  it('R20: 2-player cabo ends after the opponent’s turn', () => {
    let s = playing({ n: 2, hands: [['AS'], ['2S']] });
    s = ok(s, { type: 'CALL_CABO', playerId: 'p1' });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p0' });
    s = ok(s, { type: 'KEEP', playerId: 'p0', slot: 0 });
    s = ok(s, { type: 'TICK' }, T0 + s.timings.snapMs);
    expect(s.phase.kind).toBe('ended');
  });

  it('R22: gaps count 0, ties share the win', () => {
    const s = playing({ hands: [['5S', '-'], ['-', '-'], ['KH', '5D']] });
    expect(scoreOf(s.players[0])).toBe(5);
    expect(scoreOf(s.players[1])).toBe(0);
    expect(scoreOf(s.players[2])).toBe(5);
  });

  it('R22: exact tie → multiple winners', () => {
    let s = playing({ n: 2, hands: [['5S'], ['5D']], stock: ['KH'] });
    s = ok(s, { type: 'CALL_CABO', playerId: 'p1' });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p0' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p0' });
    s = ok(s, { type: 'TICK' }, T0 + s.timings.snapMs);
    expect(s.phase).toMatchObject({ kind: 'ended', winners: ['p0', 'p1'] });
  });

  it('R23: empty stock reshuffles discard except top; fully empty ends the round', () => {
    let s = playing({ hands: HANDS, stock: [], discard: ['2D', '3D', '4D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    expect(s.discard).toEqual([c('4D')]);
    expect(s.stock).toHaveLength(1);

    let e = playing({ hands: HANDS, stock: [], discard: ['4D'] });
    e = ok(e, { type: 'DRAW_STOCK', playerId: 'p1' });
    expect(e.phase).toMatchObject({ kind: 'ended', reason: 'deck_exhausted' });
  });

  it('actions after the end are rejected', () => {
    let s = playing({ hands: HANDS, stock: [], discard: ['4D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    expect(err(s, { type: 'DRAW_STOCK', playerId: 'p2' })).toBe('wrong_phase');
  });
});

describe('kicking offline players (REMOVE_PLAYER)', () => {
  const cur = (s: GameState) => s.players[s.currentIndex].id;
  const cards = (s: GameState) =>
    s.stock.length + s.discard.length + s.players.reduce((n, p) => n + p.slots.filter(Boolean).length, 0) + (s.phase.kind === 'drawn' ? 1 : 0);

  it('fewer than 2 players left: last one standing wins', () => {
    for (const gone of ['p0', 'p1']) {
      const s = ok(playing({ n: 2 }), { type: 'REMOVE_PLAYER', playerId: gone });
      const survivor = gone === 'p0' ? 'p1' : 'p0';
      expect(s.phase).toMatchObject({ kind: 'ended', reason: 'forfeit', winners: [survivor] });
      expect(cards(s)).toBe(54);
      expect(redactFor(s, survivor).currentPlayerId).toBe(survivor); // indices stay valid
    }
  });

  it('removing the current player hands the turn to the next seat; cards are kept', () => {
    let s = playing(); // p1 to play
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'REMOVE_PLAYER', playerId: 'p1' });
    expect(s.players.map((p) => p.id)).toEqual(['p0', 'p2']);
    expect(cur(s)).toBe('p2');
    expect(s.phase.kind).toBe('choose');
    expect(cards(s)).toBe(54);
  });

  it('removing someone seated before the current player keeps the same current player', () => {
    let s = playing({ n: 4 });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'KEEP', playerId: 'p1', slot: 0 });
    s = ok(s, { type: 'TICK' }, T0 + s.timings.snapMs); // p2's turn
    s = ok(s, { type: 'REMOVE_PLAYER', playerId: 'p0' });
    expect(cur(s)).toBe('p2');
    expect(s.phase.kind).toBe('choose');
  });

  it('removing the last seat while it is their turn wraps to seat 0', () => {
    let s = playing({ n: 3 });
    s = ok(s, { type: 'TICK' }, T0 + s.timings.turnMs); // p1 times out
    s = ok(s, { type: 'TICK' }, T0 + s.timings.turnMs + s.timings.snapMs); // p2's turn
    expect(cur(s)).toBe('p2');
    s = ok(s, { type: 'REMOVE_PLAYER', playerId: 'p2' }, T0 + s.timings.turnMs + s.timings.snapMs);
    expect(cur(s)).toBe('p0');
  });

  it('cabo: a kicked player who had a final turn pending is not waited for', () => {
    let s = playing({ n: 4 }); // p1 to play
    s = ok(s, { type: 'CALL_CABO', playerId: 'p1' }); // p2, p3, p0 still to play
    s = ok(s, { type: 'REMOVE_PLAYER', playerId: 'p3' });
    expect(cur(s)).toBe('p2');
    let t = T0;
    s = ok(s, { type: 'TICK' }, (t += s.timings.turnMs)); // p2 auto-plays
    s = ok(s, { type: 'TICK' }, (t += s.timings.snapMs));
    expect(cur(s)).toBe('p0');
    s = ok(s, { type: 'TICK' }, (t += s.timings.turnMs));
    s = ok(s, { type: 'TICK' }, (t += s.timings.snapMs));
    expect(s.phase).toMatchObject({ kind: 'ended', reason: 'cabo' });
  });

  it('cabo: kicking the caller still ends the round after everyone else has played', () => {
    let s = playing({ n: 3 });
    s = ok(s, { type: 'CALL_CABO', playerId: 'p1' }); // p2 then p0 to play
    s = ok(s, { type: 'REMOVE_PLAYER', playerId: 'p1' });
    let t = T0;
    s = ok(s, { type: 'TICK' }, (t += s.timings.turnMs));
    s = ok(s, { type: 'TICK' }, (t += s.timings.snapMs));
    expect(cur(s)).toBe('p0');
    s = ok(s, { type: 'TICK' }, (t += s.timings.turnMs));
    s = ok(s, { type: 'TICK' }, (t += s.timings.snapMs));
    expect(s.phase).toMatchObject({ kind: 'ended', reason: 'cabo' });
  });

  it('a pending give-card is cancelled if the snapper or target is kicked', () => {
    let s = playing({ hands: HANDS, stock: ['5D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    s = ok(s, { type: 'SNAP', playerId: 'p2', windowId: s.windowCounter, ownerId: 'p0', slot: 3 });
    expect(s.phase.kind).toBe('give');
    const before = cards(s);
    const t = ok(s, { type: 'REMOVE_PLAYER', playerId: 'p2' });
    expect(t.phase.kind).toBe('choose');
    expect(cur(t)).toBe('p0');
    expect(cards(t)).toBe(before);
  });

  it('peek phase: kicking the only unready player starts the round', () => {
    let s = game(3);
    s = ok(s, { type: 'READY', playerId: 'p0' });
    s = ok(s, { type: 'READY', playerId: 'p1' });
    s = ok(s, { type: 'REMOVE_PLAYER', playerId: 'p2' });
    expect(s.phase.kind).toBe('choose');
  });
});

describe('motion events (for client animations)', () => {
  const motionOf = (r: ReturnType<typeof run>) => {
    if (!r.ok) throw new Error(r.message);
    return r.events.filter((e) => !e.to && e.motion).map((e) => e.motion);
  };

  it('draw: stock → held; keep: held → slot and slot → discard with the (public) old card', () => {
    let s = playing({ hands: HANDS, stock: ['AS'] });
    expect(motionOf(run(s, { type: 'DRAW_STOCK', playerId: 'p1' }))).toEqual([
      { moves: [{ from: { at: 'stock' }, to: { at: 'held', playerId: 'p1' } }] },
    ]);
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    expect(motionOf(run(s, { type: 'KEEP', playerId: 'p1', slot: 2 }))).toEqual([
      {
        moves: [
          { from: { at: 'held', playerId: 'p1' }, to: { at: 'slot', playerId: 'p1', slot: 2 } },
          { from: { at: 'slot', playerId: 'p1', slot: 2 }, to: { at: 'discard' }, card: c('9H') },
        ],
      },
    ]);
  });

  it('blind swap moves both cards, face-down (no card values)', () => {
    let s = playing({ hands: HANDS, stock: ['QD'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    const [m] = motionOf(run(s, { type: 'BLIND_SWAP', playerId: 'p1', mySlot: 0, targetId: 'p2', slot: 3 }));
    expect(m!.moves).toEqual([
      { from: { at: 'slot', playerId: 'p1', slot: 0 }, to: { at: 'slot', playerId: 'p2', slot: 3 } },
      { from: { at: 'slot', playerId: 'p2', slot: 3 }, to: { at: 'slot', playerId: 'p1', slot: 0 } },
    ]);
  });

  it('peeks say who looked at which card, never what it is', () => {
    let s = playing({ hands: HANDS, stock: ['10S'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    const [m] = motionOf(run(s, { type: 'PEEK_OTHER', playerId: 'p1', targetId: 'p0', slot: 2 }));
    expect(m).toEqual({ peek: [{ spot: { at: 'slot', playerId: 'p0', slot: 2 }, by: 'p1' }] });
    expect(JSON.stringify(m)).not.toContain('"rank"');
  });

  it('reshuffle moves cards discard → stock before the draw that needed it', () => {
    const s = playing({ hands: HANDS, stock: [], discard: ['2D', '3D', '4D'] });
    const ms = motionOf(run(s, { type: 'DRAW_STOCK', playerId: 'p1' }));
    expect(ms[0]).toEqual({ moves: [{ from: { at: 'discard' }, to: { at: 'stock' } }, { from: { at: 'discard' }, to: { at: 'stock' } }] });
    expect(ms[1]!.moves![0]).toEqual({ from: { at: 'stock' }, to: { at: 'held', playerId: 'p1' } });
  });

  it('a departing player’s cards go back to the stock', () => {
    const s = playing({ hands: [HANDS[0], HANDS[1], ['JC', '-', 'KH']] });
    const [m] = motionOf(run(s, { type: 'REMOVE_PLAYER', playerId: 'p2' }));
    expect(m!.moves).toEqual([
      { from: { at: 'slot', playerId: 'p2', slot: 0 }, to: { at: 'stock' } },
      { from: { at: 'slot', playerId: 'p2', slot: 2 }, to: { at: 'stock' } },
    ]);
  });

  it('wrong snap flashes the revealed card and deals the penalty into the new slot', () => {
    let s = playing({ hands: HANDS, stock: ['2D', '5D'] });
    s = ok(s, { type: 'DRAW_STOCK', playerId: 'p1' });
    s = ok(s, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    const [m] = motionOf(run(s, { type: 'SNAP', playerId: 'p2', windowId: s.windowCounter, ownerId: 'p2', slot: 0 }));
    expect(m).toEqual({
      flash: [{ spot: { at: 'slot', playerId: 'p2', slot: 0 }, card: c('JC') }],
      moves: [{ from: { at: 'stock' }, to: { at: 'slot', playerId: 'p2', slot: 4 } }],
    });
  });
});

describe('R24: redaction never leaks hidden cards', () => {
  it('fuzzed random games: views only show entitled cards', () => {
    for (let seed = 1; seed <= 40; seed++) {
      let s = createGame({ players: [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}` })), seed, dealerIndex: seed % 4, now: 0 });
      let now = 0;
      let rnd = seed;
      const pick = (n: number) => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31), rnd % n);
      for (let step = 0; step < 300 && s.phase.kind !== 'ended'; step++) {
        for (const viewer of s.players) {
          const v = redactFor(s, viewer.id);
          const json = JSON.stringify(v);
          if (s.phase.kind === 'drawn' && s.players[s.currentIndex].id !== viewer.id) {
            expect(v.drawnCard).toBeNull();
          }
          v.players.forEach((pv) =>
            pv.slots.forEach((sv, i) => {
              if (sv?.card) {
                const peek = s.phase.kind === 'peek' && pv.id === viewer.id && !viewer.ready && i >= 2;
                expect(peek).toBe(true);
              }
            }),
          );
          expect(json).not.toContain('stock"');
        }
        const cur = s.players[s.currentIndex].id;
        const tries: Action[] = [
          { type: 'READY', playerId: s.players[pick(4)].id },
          { type: 'DRAW_STOCK', playerId: cur },
          { type: 'TAKE_DISCARD', playerId: cur, slot: pick(4) },
          { type: 'KEEP', playerId: cur, slot: pick(4) },
          { type: 'DISCARD_DRAWN', playerId: cur },
          { type: 'PEEK_OWN', playerId: cur, slot: pick(4) },
          { type: 'PEEK_OTHER', playerId: cur, targetId: `p${pick(4)}`, slot: pick(4) },
          { type: 'BLIND_SWAP', playerId: cur, mySlot: pick(4), targetId: `p${pick(4)}`, slot: pick(4) },
          { type: 'SWAP', playerId: cur, mySlot: pick(4) },
          { type: 'SKIP', playerId: s.phase.kind === 'give' ? s.phase.snapperId : cur },
          { type: 'GIVE_CARD', playerId: s.phase.kind === 'give' ? s.phase.snapperId : cur, mySlot: pick(4) },
          { type: 'SNAP', playerId: s.players[pick(s.players.length)].id, windowId: s.windowCounter, ownerId: s.players[pick(s.players.length)].id, slot: pick(5) },
          { type: 'TICK' },
        ];
        if (step > 250 && s.caboCalledBy === null && s.phase.kind === 'choose') tries.unshift({ type: 'CALL_CABO', playerId: cur });
        if (step % 97 === 96) tries.unshift({ type: 'REMOVE_PLAYER', playerId: s.players[pick(s.players.length)].id });
        const a = step % 97 === 96 ? tries[0] : tries[pick(tries.length)];
        if (a.type === 'TICK') now = s.deadline ?? now;
        const r = applyAction(s, a, now);
        if (r.ok) {
          // R24 for motions: a card face only rides along when that card is public.
          for (const e of r.events) {
            if (e.to) expect(e.motion).toBeUndefined();
            for (const mv of e.motion?.moves ?? []) {
              if (mv.card) expect(mv.from.at === 'discard' || mv.to.at === 'discard').toBe(true);
            }
            for (const f of e.motion?.flash ?? []) if (f.card) expect(e.text).toContain('tried to snap');
            for (const pk of e.motion?.peek ?? []) expect(pk).not.toHaveProperty('card');
          }
          s = r.state;
        }
        // card conservation
        const total = s.stock.length + s.discard.length + s.players.reduce((n, p) => n + p.slots.filter(Boolean).length, 0) + (s.phase.kind === 'drawn' ? 1 : 0);
        expect(total).toBe(54);
      }
      for (const viewer of s.players) expect(() => redactFor(s, viewer.id)).not.toThrow();
    }
  });
});
