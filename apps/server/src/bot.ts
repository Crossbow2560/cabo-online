import { cardValue, type Action, type BotLevel, type Card, type GameEvent, type PlayerView, type Spot } from '@cabo/engine';

export interface BotPreset {
  /** Pause before each move (ms). */
  think: [number, number];
  /** Chance of taking a snap it has spotted (1 = always, 0 = never). */
  snap: number;
  /** Reaction time before snapping (ms). */
  snapDelay: [number, number];
}

/** Difficulty presets: how fast a bot moves and whether it snaps. Its strategy is the same at every level. */
export const BOT_PRESETS: Record<BotLevel, BotPreset> = {
  beginner: { think: [3000, 5000], snap: 0, snapDelay: [2000, 2500] },
  novice: { think: [2500, 3000], snap: 0.5, snapDelay: [1750, 2250] },
  intermediate: { think: [1000, 2000], snap: 0.5, snapDelay: [1000, 2000] },
  expert: { think: [750, 2000], snap: 1, snapDelay: [750, 1500] },
};

/**
 * A server-side bot player. It plays only from what its seat is entitled to: its redacted
 * view plus the public and private events it would receive as a client. Card memory is kept
 * exact by following every card `motion` (keeps, swaps, gives, snaps), so it can snap and
 * blind-swap opponents' cards it has seen.
 */
export class BotBrain {
  /** `slot:<playerId>:<i>` or `held:<playerId>` → card this seat knows is there. */
  private known = new Map<string, Card>();
  private turns = 0;
  private turnVersion = -1;
  private snappedWindow: number | null = null;

  constructor(readonly id: string) {}

  reset() {
    this.known.clear();
    this.turns = 0;
    this.snappedWindow = null;
  }

  /** Feed every public event, and every private event addressed to this bot. */
  observe(e: GameEvent) {
    if (e.to && e.to !== this.id) return;
    if (e.reveal) this.known.set(slotKey(e.reveal.playerId, e.reveal.slot), e.reveal.card);
    const m = e.motion;
    if (!m) return;
    for (const f of m.flash ?? []) if (f.card) this.known.set(key(f.spot), f.card);
    if (m.moves?.length) {
      // Moves happen at once (a swap is two moves), so read every source before writing.
      const carried = m.moves.map((mv) => mv.card ?? this.known.get(key(mv.from)));
      for (const mv of m.moves) this.known.delete(key(mv.from));
      m.moves.forEach((mv, i) => {
        const c = carried[i];
        if (c && (mv.to.at === 'slot' || mv.to.at === 'held')) this.known.set(key(mv.to), c);
        else this.known.delete(key(mv.to));
      });
    }
  }

  /** Remember whatever is face-up to this seat right now. */
  see(view: PlayerView) {
    for (const p of view.players) {
      p.slots.forEach((s, i) => {
        if (!s) this.known.delete(slotKey(p.id, i));
        else if (s.card) this.known.set(slotKey(p.id, i), s.card);
      });
    }
    if (view.drawnCard) this.known.set(`held:${this.id}`, view.drawnCard);
  }

  /** The next move for this view, or null to wait. */
  decide(view: PlayerView): Action | null {
    this.see(view);
    const me = this.id;
    const base = { playerId: me, expectedVersion: view.version };
    const my = this.slots(view, me);
    const myTurn = view.currentPlayerId === me;

    switch (view.phase) {
      case 'peek': {
        const p = view.players.find((x) => x.id === me);
        return p && !p.ready ? { type: 'READY', ...base } : null;
      }
      case 'snap': {
        if (view.snapWindowId === null || this.snappedWindow === view.snapWindowId || !view.discardTop) return null;
        const rank = view.discardTop.rank;
        // Own matches first; opponents' only if we have a card to give back.
        const own = my.find((s) => s.card?.rank === rank);
        const theirs = my.length
          ? view.players.filter((p) => p.id !== me).flatMap((p) => this.slots(view, p.id)).find((s) => s.card?.rank === rank)
          : undefined;
        const target = own ?? theirs;
        if (!target) return null;
        this.snappedWindow = view.snapWindowId;
        return { type: 'SNAP', playerId: me, windowId: view.snapWindowId, ownerId: target.playerId, slot: target.slot };
      }
      case 'give': {
        if (view.give?.snapperId !== me) return null;
        const worst = this.worst(my);
        if (worst && worst.pts >= 5) return { type: 'GIVE_CARD', mySlot: worst.slot, ...base };
        const unknown = my.find((s) => !s.card);
        if (unknown) return { type: 'GIVE_CARD', mySlot: unknown.slot, ...base };
        return { type: 'SKIP', ...base };
      }
      case 'choose': {
        if (!myTurn) return null;
        if (this.turnVersion !== view.version) this.turns++;
        this.turnVersion = view.version;
        const estimate = my.reduce((t, s) => t + (s.card ? cardValue(s.card) : 6.5), 0);
        const unknown = my.filter((s) => !s.card).length;
        if (!view.caboCalledBy && ((unknown === 0 && estimate <= 6) || (this.turns > 12 && estimate <= 14))) {
          return { type: 'CALL_CABO', ...base };
        }
        const top = view.discardTop;
        const into = top && cardValue(top) <= 3 ? this.slotFor(my, cardValue(top)) : null;
        if (into !== null) return { type: 'TAKE_DISCARD', slot: into, ...base };
        return { type: 'DRAW_STOCK', ...base };
      }
      case 'drawn': {
        if (!myTurn || !view.drawnCard) return null;
        const into = this.slotFor(my, cardValue(view.drawnCard));
        return into !== null ? { type: 'KEEP', slot: into, ...base } : { type: 'DISCARD_DRAWN', ...base };
      }
      case 'ability':
        return myTurn ? this.ability(view, my, base) : null;
      default:
        return null;
    }
  }

  private ability(view: PlayerView, my: SlotInfo[], base: { playerId: string; expectedVersion: number }): Action {
    const others = view.players.filter((p) => p.id !== this.id).flatMap((p) => this.slots(view, p.id));
    const unknownOthers = others.filter((s) => !s.card);
    // R29: the CABO caller's cards can't be swapped, so swaps (and Black King looks) aim elsewhere.
    const swappable = others.filter((s) => s.playerId !== view.caboCalledBy);
    const unknownSwappable = swappable.filter((s) => !s.card);
    const skip: Action = { type: 'SKIP', ...base };
    switch (view.ability) {
      case 'peek_own': {
        const u = my.find((s) => !s.card);
        return u ? { type: 'PEEK_OWN', slot: u.slot, ...base } : skip;
      }
      case 'peek_other': {
        const t = pick(unknownOthers);
        return t ? { type: 'PEEK_OTHER', targetId: t.playerId, slot: t.slot, ...base } : skip;
      }
      case 'blind_swap': {
        const worst = this.worst(my);
        if (!worst) return skip;
        // A known low card of theirs beats a blind gamble.
        const best = swappable.filter((s) => s.card).sort((a, b) => a.pts - b.pts)[0];
        if (best && best.pts <= worst.pts - 3) return { type: 'BLIND_SWAP', mySlot: worst.slot, targetId: best.playerId, slot: best.slot, ...base };
        const t = pick(unknownSwappable);
        if (t && worst.pts >= 10) return { type: 'BLIND_SWAP', mySlot: worst.slot, targetId: t.playerId, slot: t.slot, ...base };
        return skip;
      }
      case 'look_swap': {
        if (!view.abilityPeeked) {
          const t = pick(unknownSwappable) ?? swappable.sort((a, b) => a.pts - b.pts)[0] ?? pick(others);
          return t ? { type: 'PEEK_OTHER', targetId: t.playerId, slot: t.slot, ...base } : skip;
        }
        if (view.abilityPeekedMine === null) {
          const mine = this.worst(my) ?? my.find((s) => !s.card) ?? my[0];
          return mine ? { type: 'PEEK_OWN', slot: mine.slot, ...base } : skip;
        }
        const theirs = this.known.get(slotKey(view.abilityPeeked.playerId, view.abilityPeeked.slot));
        const mine = this.known.get(slotKey(this.id, view.abilityPeekedMine));
        const canSwap = view.abilityPeeked.playerId !== view.caboCalledBy;
        return canSwap && theirs && mine && cardValue(theirs) < cardValue(mine) ? { type: 'SWAP', mySlot: view.abilityPeekedMine, ...base } : skip;
      }
      default:
        return skip;
    }
  }

  /** Where to keep a card worth `pts`: over the worst known card if it's lower, else an unknown slot if it's low. */
  private slotFor(my: SlotInfo[], pts: number): number | null {
    const worst = this.worst(my);
    if (worst && pts < worst.pts) return worst.slot;
    const unknown = my.find((s) => !s.card);
    if (unknown && pts <= 5) return unknown.slot;
    return null;
  }

  private worst(slots: SlotInfo[]): SlotInfo | undefined {
    return slots.filter((s) => s.card).sort((a, b) => b.pts - a.pts)[0];
  }

  private slots(view: PlayerView, playerId: string): SlotInfo[] {
    const p = view.players.find((x) => x.id === playerId);
    if (!p) return [];
    return p.slots.flatMap((s, slot) => {
      if (!s) return [];
      const card = this.known.get(slotKey(playerId, slot)) ?? null;
      return [{ playerId, slot, card, pts: card ? cardValue(card) : 6.5 }];
    });
  }
}

interface SlotInfo {
  playerId: string;
  slot: number;
  card: Card | null;
  pts: number;
}

const slotKey = (playerId: string, slot: number) => `slot:${playerId}:${slot}`;
const key = (s: Spot) => (s.at === 'slot' ? slotKey(s.playerId, s.slot) : s.at === 'held' ? `held:${s.playerId}` : s.at);
const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(Math.random() * xs.length)];
