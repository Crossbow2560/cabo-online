import type { ClientAction, PlayerView } from '@cabo/engine';

/** R10: the Black King swap being chosen: one of my cards and another player's card. */
export interface KingChoice {
  mine: number | null;
  target: { playerId: string; slot: number } | null;
}

export type Pick = null | 'take_discard' | { blindMine: number } | { king: KingChoice };

/** The J/Q blind swap's chosen card of mine, if any. */
export const blindPick = (p: Pick): number | null => (p && typeof p === 'object' && 'blindMine' in p ? p.blindMine : null);

/** Black King, after both looks: the player picks the swap (any card of theirs, any other player's). */
export const kingDeciding = (view: PlayerView) =>
  view.phase === 'ability' && view.ability === 'look_swap' && !!view.abilityPeeked && view.abilityPeekedMine !== null;

/** The swap currently chosen: what the player tapped, else the two cards they looked at (never a CABO caller's). */
export function kingChoice(view: PlayerView, pick: Pick): KingChoice {
  if (pick && typeof pick === 'object' && 'king' in pick) return pick.king;
  const p = view.abilityPeeked;
  return { mine: view.abilityPeekedMine, target: p && p.playerId !== view.caboCalledBy ? p : null };
}

/** Context buttons for the current phase (logic carried over from the interim Controls). */
export function ActionBar({ view, pick, setPick, act, snapLeft, snapStatus }: {
  view: PlayerView;
  pick: Pick;
  setPick: (p: Pick) => void;
  act: (a: ClientAction) => void;
  /** 0..1 of the snap window remaining. */
  snapLeft: number;
  /** This player snapped ('sent') or their window ran out ('over'); the server decides once everyone's in. */
  snapStatus: 'sent' | 'over' | null;
}) {
  const me = view.you;
  const myTurn = view.currentPlayerId === me;
  const mePlayer = view.players.find((p) => p.id === me)!;
  const hasCards = mePlayer.slots.some(Boolean);

  // R30: the first snapper's streak: snap another of the same rank from their own hand, or stop.
  if (view.phase === 'snap' && view.snapOnlyFor) {
    const rank = view.discardTop?.rank ?? '';
    const mine = view.snapOnlyFor === me;
    const who = view.players.find((p) => p.id === view.snapOnlyFor)?.name ?? 'The snapper';
    return (
      <div className="actions">
        <div className="snap-banner snap-banner--streak" role="status">
          <span className="snap-banner__word">{mine ? 'STREAK!' : 'SNAP!'}</span>
          <span className="snap-banner__hint">
            {mine ? (snapStatus === 'sent' ? 'Checking…' : `Snap another ${rank} of yours`) : `${who} may snap more ${rank}s`}
          </span>
          {mine && (
            <button className="btn btn--light btn--sm snap-banner__done" onClick={() => act({ type: 'SKIP' })}>
              Done
            </button>
          )}
          <span className="snap-banner__bar" style={{ transform: `scaleX(${snapLeft})` }} />
        </div>
      </div>
    );
  }
  if (view.phase === 'snap') {
    return (
      <div className="actions">
        <div className="snap-banner" role="status">
          <span className="snap-banner__word">SNAP!</span>
          <span className="snap-banner__hint">
            {snapStatus === 'sent' ? 'Snap sent — checking who was first…' : snapStatus === 'over' ? 'Waiting for everyone’s snaps…' : 'Tap a card that matches the discard'}
          </span>
          <span className="snap-banner__bar" style={{ transform: `scaleX(${snapLeft})` }} />
        </div>
      </div>
    );
  }
  if (view.phase === 'peek') {
    return (
      <div className="actions">
        {mePlayer.ready ? (
          <span className="actions__note">Waiting for the others…</span>
        ) : (
          <button className="btn btn--primary" onClick={() => act({ type: 'READY' })}>
            I've memorised them
          </button>
        )}
      </div>
    );
  }
  if (view.phase === 'give' && view.give?.snapperId === me) {
    return (
      <div className="actions">
        <button className="btn btn--light" onClick={() => act({ type: 'SKIP' })}>Don't give a card</button>
      </div>
    );
  }
  if (!myTurn || view.phase === 'ended') return <div className="actions" />;

  switch (view.phase) {
    case 'choose':
      // Drawing / taking the discard happens by tapping the piles; only Cabo is a button.
      return (
        <div className="actions">
          <button className="btn btn--primary" onClick={() => act({ type: 'CALL_CABO' })} disabled={!!view.caboCalledBy || pick !== null}>
            Call CABO
          </button>
        </div>
      );
    case 'drawn':
      return (
        <div className="actions">
          <button className="btn btn--primary" onClick={() => act({ type: 'DISCARD_DRAWN' })}>Discard it</button>
          {hasCards && <span className="actions__note">…or tap one of your cards to keep it</span>}
        </div>
      );
    case 'ability':
      // Black King, after looking at both cards (R10): swap the chosen pair, or keep everything.
      if (kingDeciding(view)) {
        const c = kingChoice(view, pick);
        const ready = c.mine !== null && c.target !== null;
        return (
          <div className="actions">
            <button
              className="btn btn--primary"
              disabled={!ready}
              onClick={() => ready && act({ type: 'SWAP', mySlot: c.mine!, targetId: c.target!.playerId, slot: c.target!.slot })}
            >
              Swap
            </button>
            <button className="btn btn--light" onClick={() => act({ type: 'SKIP' })}>Keep them</button>
          </div>
        );
      }
      return (
        <div className="actions">
          <button className="btn btn--light" onClick={() => act({ type: 'SKIP' })}>Skip ability</button>
        </div>
      );
    default:
      return <div className="actions" />;
  }
}
