export type Suit = 'S' | 'C' | 'H' | 'D';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'JOKER';

export interface Card {
  rank: Rank;
  suit: Suit | null; // null for jokers
}

export const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS: Suit[] = ['S', 'C', 'H', 'D'];

export function isBlack(card: Card): boolean {
  return card.suit === 'S' || card.suit === 'C';
}

/** Scoring table from the spec. */
export function cardValue(card: Card): number {
  switch (card.rank) {
    case 'JOKER': return -1;
    case 'A': return 1;
    case 'J': return 11;
    case 'Q': return 12;
    case 'K': return isBlack(card) ? 13 : 0;
    default: return Number(card.rank);
  }
}

export type Ability = 'peek_own' | 'peek_other' | 'blind_swap' | 'look_swap';

/** R8: only black kings have look & swap; red kings and jokers have no ability. */
export function abilityOf(card: Card): Ability | null {
  switch (card.rank) {
    case '7': case '8': return 'peek_own';
    case '9': case '10': return 'peek_other';
    case 'J': case 'Q': return 'blind_swap';
    case 'K': return isBlack(card) ? 'look_swap' : null;
    default: return null;
  }
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  deck.push({ rank: 'JOKER', suit: null }, { rank: 'JOKER', suit: null });
  return deck;
}

const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', C: '♣', H: '♥', D: '♦' };

export function cardLabel(card: Card): string {
  return card.rank === 'JOKER' ? 'Joker' : `${card.rank}${SUIT_SYMBOL[card.suit!]}`;
}

/** mulberry32 — state is a plain number so it serialises inside GameState. */
export function nextRandom(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

export function shuffle<T>(items: T[], seed: number): [T[], number] {
  const out = items.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    const [r, n] = nextRandom(s);
    s = n;
    const j = Math.floor(r * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return [out, s];
}
