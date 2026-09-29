import type { ClientAction, PlayerView } from '@cabo/engine';

export type Pick = null | 'take_discard' | { blindMine: number };

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
      // Black King, after looking at both cards: decide.
      if (view.ability === 'look_swap' && view.abilityPeeked && view.abilityPeekedMine !== null) {
        return (
          <div className="actions">
            <button className="btn btn--primary" onClick={() => act({ type: 'SWAP', mySlot: view.abilityPeekedMine! })}>Swap them</button>
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
