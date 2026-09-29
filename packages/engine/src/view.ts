import type { Ability, Card } from './cards';
import { PEEK_SLOTS, type GameState, type Phase } from './state';

/** A slot as one viewer sees it: `card` is null when face-down to them. */
export interface SlotView {
  card: Card | null;
}

export interface PlayerView {
  you: string;
  version: number;
  phase: Phase['kind'];
  currentPlayerId: string;
  dealerId: string;
  deadline: number | null;
  caboCalledBy: string | null;
  stockCount: number;
  discardTop: Card | null;
  players: { id: string; name: string; ready: boolean; slots: (SlotView | null)[] }[];
  /** Only set for the player holding it. */
  drawnCard: Card | null;
  /** The pending ability (public: the discarded card is face-up). */
  ability: Ability | null;
  /** look_swap: which card the current player looked at (card value comes via private event only). */
  abilityPeeked: { playerId: string; slot: number } | null;
  /** look_swap: which of their own cards they looked at next. */
  abilityPeekedMine: number | null;
  snapWindowId: number | null;
  /** R31: during a `settle` pause, whether it follows a peek or a swap. */
  lastSettle: 'peek' | 'swap' | null;
  /** R30: set during a snap streak; only this player may snap (their own cards). */
  snapOnlyFor: string | null;
  /** Length of a snap window; each client times its own window from when it sees it open. */
  snapMs: number;
  give: { snapperId: string; targetId: string; slot: number } | null;
  result: { reason: string; scores: Record<string, number>; winners: string[] } | null;
}

/**
 * R24: the only function that turns authoritative state into something sent to a client.
 * A card value appears here only if `viewerId` is entitled to see it right now.
 */
export function redactFor(s: GameState, viewerId: string): PlayerView {
  const ph = s.phase;
  const ended = ph.kind === 'ended';
  const current = s.players[s.currentIndex];
  return {
    you: viewerId,
    version: s.version,
    phase: ph.kind,
    currentPlayerId: current.id,
    dealerId: s.players[s.dealerIndex].id,
    deadline: s.deadline,
    caboCalledBy: s.caboCalledBy,
    stockCount: s.stock.length,
    discardTop: s.discard[s.discard.length - 1] ?? null,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      slots: p.slots.map((card, i) => {
        if (!card) return null;
        const peeking = ph.kind === 'peek' && p.id === viewerId && !p.ready && PEEK_SLOTS.includes(i);
        return { card: ended || peeking ? card : null };
      }),
    })),
    drawnCard: ph.kind === 'drawn' && current.id === viewerId ? ph.card : null,
    ability: ph.kind === 'ability' ? ph.ability : null,
    abilityPeeked: ph.kind === 'ability' ? ph.peeked ?? null : null,
    abilityPeekedMine: ph.kind === 'ability' ? ph.peekedMine ?? null : null,
    snapWindowId: ph.kind === 'snap' ? ph.windowId : null,
    snapOnlyFor: ph.kind === 'snap' ? ph.onlyFor ?? null : null,
    lastSettle: ph.kind === 'settle' ? ph.after : null,
    snapMs: s.timings.snapMs,
    give: ph.kind === 'give' ? { snapperId: ph.snapperId, targetId: ph.targetId, slot: ph.slot } : null,
    result: ph.kind === 'ended' ? { reason: ph.reason, scores: ph.scores, winners: ph.winners } : null,
  };
}
