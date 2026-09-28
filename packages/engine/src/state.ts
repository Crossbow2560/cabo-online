import type { Ability, Card } from './cards';

export interface Timings {
  peekMs: number;   // R2 / R25: peek phase auto-ready
  turnMs: number;   // R25: whole turn (choose + drawn)
  choiceMs: number; // R25 / R17: ability and give-card choices
  snapMs: number;   // R12: snap window
}

export const DEFAULT_TIMINGS: Timings = {
  peekMs: 15_000,
  turnMs: 60_000,
  choiceMs: 15_000,
  snapMs: 3_000,
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

export type Phase =
  | { kind: 'peek' }
  | { kind: 'choose' }
  | { kind: 'drawn'; card: Card }
  | {
      kind: 'ability';
      ability: Ability;
      /** look_swap only: set after the peek step (R10). */
      peeked?: { playerId: string; slot: number };
    }
  | { kind: 'snap'; windowId: number }
  | { kind: 'give'; snapperId: string; targetId: string; slot: number }
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
  | ({ type: 'SWAP'; mySlot: number } & Base)
  | ({ type: 'SKIP' } & Base)
  | ({ type: 'GIVE_CARD'; mySlot: number } & Base)
  | { type: 'SNAP'; playerId: string; windowId: number; ownerId: string; slot: number }
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
  /** Cards to call attention to (someone peeked at it; a wrong snap reveals `card`). */
  flash?: { spot: Spot; card?: Card }[];
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
