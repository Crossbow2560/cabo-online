import { useEffect, useRef } from 'react';
import type { FinalStandings } from '@cabo/engine';

/** Game over: everyone's final total (lowest wins), shown over the lobby when the host ends a game. */
export function FinalResults({ final, me, onClose }: { final: FinalStandings; me: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const winners = final.standings.filter((s) => final.winners.includes(s.id)).map((s) => s.name);

  return (
    <dialog ref={ref} className="modal modal--small" aria-labelledby="final-title" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="panel final">
        <h2 id="final-title" className="heading final__title">
          🏆 {winners.join(' & ')} {winners.length > 1 ? 'win' : 'wins'} the game!
        </h2>
        <p className="final__why">
          {final.reason === 'limit'
            ? `${final.standings.filter((s) => final.losers.includes(s.id)).map((s) => s.name).join(' & ')} reached the points limit. `
            : ''}
          Final totals after {final.rounds} round{final.rounds === 1 ? '' : 's'}, lowest wins.
        </p>
        <ol className="final__list">
          {final.standings.map((s, i) => (
            <li key={s.id} className={`final__row ${final.winners.includes(s.id) ? 'final__row--win' : ''}`}>
              <span className="final__place">{i + 1}</span>
              <span className="final__name">
                {s.name}
                {s.id === me && <span className="you-tag">(you)</span>}
                {final.losers.includes(s.id) && <span className="final__bust">Busted</span>}
              </span>
              <span className="final__total">{s.total}</span>
            </li>
          ))}
        </ol>
        <button className="btn btn--primary" onClick={onClose} autoFocus>
          Back to the lobby
        </button>
      </div>
    </dialog>
  );
}
