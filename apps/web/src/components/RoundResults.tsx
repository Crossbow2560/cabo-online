import { cardValue, type PlayerView, type RoomState } from '@cabo/engine';
import { PlayingCard } from './PlayingCard';

/** Shown over the felt when a round ends: winner, everyone's revealed cards, round scores, running totals. */
export function RoundResults({ view, room, onStart }: { view: PlayerView; room: RoomState; onStart: () => void }) {
  const result = view.result!;
  const me = view.you;
  const isHost = room.hostId === me;
  const name = (id: string) => view.players.find((p) => p.id === id)?.name ?? 'a player who left';
  const total = (id: string) => room.players.find((p) => p.id === id)?.totalScore ?? 0;
  const rows = [...view.players].sort((a, b) => result.scores[a.id] - result.scores[b.id]);
  const winners = result.winners.map(name).join(' & ');

  return (
    <div className="panel results" role="dialog" aria-labelledby="results-title">
      <h2 id="results-title" className="heading results__title">
        🏆 {winners} {result.winners.length > 1 ? 'win' : 'wins'}!
      </h2>
      <p className="results__why">
        {result.reason === 'cabo' && 'Cabo was called — all cards revealed.'}
        {result.reason === 'deck_exhausted' && 'The deck ran dry — all cards revealed.'}
        {result.reason === 'forfeit' && 'Last one standing — everyone else left the table.'}
      </p>
      <div className="results__head" aria-hidden>
        <span>Player &amp; cards</span>
        <span>Round</span>
        <span>Total</span>
      </div>
      <ul className="results__list">
        {rows.map((p) => (
          <li key={p.id} className={`results__row ${result.winners.includes(p.id) ? 'results__row--win' : ''}`}>
            <div className="results__who">
              <span className="results__name">
                {result.winners.includes(p.id) && '🏆 '}
                {p.name}
                {p.id === me && <span className="you-tag">(you)</span>}
              </span>
              <span className="results__cards">
                {p.slots.map((s, i) =>
                  s?.card ? (
                    <span key={i} className="results__card" title={`${s.card.rank === 'JOKER' ? 'Joker' : s.card.rank} = ${cardValue(s.card)}`}>
                      <PlayingCard card={s.card} size="sm" />
                    </span>
                  ) : null,
                )}
                {!p.slots.some((s) => s?.card) && <span className="results__none">no cards</span>}
              </span>
            </div>
            <span className="results__score">{result.scores[p.id]}</span>
            <span className="results__total">{total(p.id)}</span>
          </li>
        ))}
      </ul>
      {isHost ? (
        <button className="btn btn--primary" onClick={onStart} disabled={room.players.length < 2}>
          {room.players.length < 2 ? 'Need 2 players' : 'Start next round'}
        </button>
      ) : (
        <p className="results__wait">Waiting for the host to deal again…</p>
      )}
    </div>
  );
}
