import type { Ability, Card } from './cards';

export interface Timings {
  peekMs: number;   // R2 / R25: peek phase auto-ready
  turnMs: number;   // R25: whole turn (choose + drawn)
  choiceMs: number; // R25 / R17: ability and give-card choices
  snapMs: number;   // R12: snap window
  /** R31: pause after a 7/8/9/10 peek before the snap window, while the peeked card is shown and put back. */
  peekViewMs: number;
  /** R31: pause after a swap before the snap window, while the two cards cross. */
  swapSettleMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  peekMs: 20_000,
  turnMs: 60_000,
  choiceMs: 15_000,
  snapMs: 3_500,
  peekViewMs: 6_000, // the client's peek animation is 5.6s (lib/motion.ts PEEK_MS)
  swapSettleMs: 1_800, // the client's swap animation is 1.6s (lib/motion.ts SWAP_MS)
};

/** R2: the two cards nearest the player (bottom row of the 2x2 grid). */
export const PEEK_SLOTS = [2, 3];
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export interface PlayerState {
  id: string;
  name: string;
  /** null = gap left by a snap (R18). */
  slots: (Card | null)[];
  ready: boolean;
}

/** A special card's power in use. */
export interface AbilityPhase {
  kind: 'ability';
  ability: Ability;
  /** look_swap (R10): the other player's card they looked at, then their own card they looked at. */
  peeked?: { playerId: string; slot: number };
  peekedMine?: number;
}

export type Phase =
  | { kind: 'peek' }
  | { kind: 'choose' }
  | { kind: 'drawn'; card: Card }
  | AbilityPhase
  /**
   * `onlyFor` (R30): a snap streak. After the first correct snap, the snapper alone gets another
   * window to snap more cards of the same rank from their own hand.
   */
  /** `opening` (R3): the window on the first face-up discard, once everyone has memorised. */
  | { kind: 'snap'; windowId: number; onlyFor?: string; opening?: boolean }
  | { kind: 'give'; snapperId: string; targetId: string; slot: number }
  /**
   * R31: a short pause before the snap window while a looked-at card is shown and put back, or
   * two swapped cards cross. The cards are in the air, so nobody could tap them anyway.
   */
  /**
   * `resume` (R10): a Black King's look. Once the card is back, the ability carries on (the next
   * look, or choosing the swap) instead of opening the snap window.
   */
  | { kind: 'settle'; after: 'peek' | 'swap'; resume?: AbilityPhase }
  | {
      kind: 'ended';
      /** forfeit = fewer than 2 players left after removals; the survivor wins. */
      reason: 'cabo' | 'deck_exhausted' | 'forfeit';
      scores: Record<string, number>;
      winners: string[];
    };

export interface GameState {
  players: PlayerState[];
  stock: Card[];
  discard: Card[];
  dealerIndex: number;
  currentIndex: number;
  phase: Phase;
  /** Epoch ms when the current phase times out (R25); null when nothing is pending. */
  deadline: number | null;
  caboCalledBy: string | null;
  /** After Cabo: how many more turns are left before the reveal (R21). */
  finalTurnsRemaining: number;
  windowCounter: number;
  version: number;
  rng: number;
  timings: Timings;
}

interface Base { playerId: string; expectedVersion?: number }

export type Action =
  | ({ type: 'READY' } & Base)
  | ({ type: 'DRAW_STOCK' } & Base)
  | ({ type: 'TAKE_DISCARD'; slot: number } & Base)
  | ({ type: 'CALL_CABO' } & Base)
  | ({ type: 'KEEP'; slot: number } & Base)
  | ({ type: 'DISCARD_DRAWN' } & Base)
  | ({ type: 'PEEK_OWN'; slot: number } & Base)
  | ({ type: 'PEEK_OTHER'; targetId: string; slot: number } & Base)
  | ({ type: 'BLIND_SWAP'; mySlot: number; targetId: string; slot: number } & Base)
  /**
   * R10: the Black King's swap, after looking at a card of theirs and one of yours. Any of your
   * cards with any other player's card (not only the two looked at); `targetId`/`slot` default to
   * the other player's card you looked at.
   */
  | ({ type: 'SWAP'; mySlot: number; targetId?: string; slot?: number } & Base)
  | ({ type: 'SKIP' } & Base)
  | ({ type: 'GIVE_CARD'; mySlot: number } & Base)
  /**
   * `at` (server-set only): when the snap effectively happened. Snaps are gathered for the whole
   * window and replayed in reaction-time order, so this can be earlier than the time applied.
   */
  | { type: 'SNAP'; playerId: string; windowId: number; ownerId: string; slot: number; at?: number }
  | { type: 'TICK' }
  /** System action (server only): a player left or was kicked for being offline too long. */
  | { type: 'REMOVE_PLAYER'; playerId: string; reason?: string };

/** A place a card can be on the table. `held` = the card a player drew and hasn't placed yet. */
export type Spot =
  | { at: 'slot'; playerId: string; slot: number }
  | { at: 'stock' }
  | { at: 'discard' }
  | { at: 'held'; playerId: string };

/**
 * What physically moved, so clients can animate it. Public: `card` is only set when that card is
 * already public (going to / coming from the discard, or revealed by a wrong snap).
 */
export interface Motion {
  moves?: { from: Spot; to: Spot; card?: Card }[];
  /** A wrong snap: the card is shown to everyone. */
  flash?: { spot: Spot; card?: Card }[];
  /** `by` looked at the card at `spot` (never carries the card; the peeker gets it privately). */
  peek?: { spot: Spot; by: string }[];
}

/** A log line. `to` set = private to that player (peek results); otherwise public. */
export interface GameEvent {
  motion?: Motion;
  to?: string;
  text: string;
  /** Private peeks only: which card to flip face-up for the peeker. */
  reveal?: { playerId: string; slot: number; card: Card };
}

export type ActionError =
  | 'stale'
  | 'not_your_turn'
  | 'wrong_phase'
  | 'invalid'
  | 'too_slow'
  | 'not_due';

export type ActionResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: ActionError; message: string };
