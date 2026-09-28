import type { PlayerView, RoomState } from '@cabo/engine';

/** Shown over the felt when a round ends: winner, round scores, running totals. */
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
      <table className="results__table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Round</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className={result.winners.includes(p.id) ? 'results__win' : ''}>
              <td>
                {p.name}
                {p.id === me && <span className="you-tag">(you)</span>}
              </td>
              <td>{result.scores[p.id]}</td>
              <td>{total(p.id)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
