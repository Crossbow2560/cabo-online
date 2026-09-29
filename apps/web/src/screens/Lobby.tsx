import { MAX_PLAYERS, MIN_PLAYERS, type RoomState } from '@cabo/engine';
import { CopyField } from '../components/CopyField';
import { Icon } from '../components/Icon';
import { Title } from '../components/Title';
import { usePublicUrl } from '../lib/config';
import { formatCountdown, useNow } from '../lib/useNow';

const MIN_ROWS = 3;

export function Lobby({ room, me, onStart, onLeave, onAddBot, onRemoveBot }: {
  room: RoomState;
  me: string;
  onStart: () => void;
  onLeave: () => void;
  onAddBot: () => void;
  onRemoveBot: (id: string) => void;
}) {
  const now = useNow(1000);
  const isHost = room.hostId === me;
  const link = `${usePublicUrl()}/?room=${room.code}`;
  const enough = room.players.length >= MIN_PLAYERS;
  const emptyRows = Math.max(0, MIN_ROWS - room.players.length);

  return (
    <main className="screen screen--top">
      <Title size="md" />

      <h2 className="greeting lobby__heading">
        <Icon name="law-star" className="lobby__star" />
        {isHost ? 'Create Room' : 'Join Room'}
        <Icon name="law-star" className="lobby__star" />
      </h2>

      <section className="panel lobby__panel share" aria-label="Invite">
        <CopyField label="Invite link" value={link} variant="url" />
        <CopyField label="Room code" value={room.code} variant="code" />
      </section>

      <section className="panel lobby__panel posse" aria-label="Players">
        <div className="posse__head">
          <span className="posse__title">
            Posse <span className="posse__count">({room.players.length}/{MAX_PLAYERS})</span>
          </span>
          <div className="posse__actions">
            {isHost && (
              <button className="btn btn--light btn--sm" onClick={onAddBot} disabled={room.players.length >= MAX_PLAYERS}>
                + Add bot
              </button>
            )}
            <button className="btn btn--primary btn--sm" onClick={onLeave}>
              Leave room
            </button>
          </div>
        </div>
        <div className="posse__scroll">
          <table className="posse__table">
            <thead>
              <tr className="posse__cols">
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col" className="posse__status-col">Status</th>
              </tr>
            </thead>
            <tbody>
              {room.players.map((p, i) => (
                <tr key={p.id}>
                  <td className="posse__seat">{i + 1}</td>
                  <td>
                    <span className="posse__name">{p.name}</span>
                    {p.id === room.hostId && (
                      <span className="host-tag">
                        <Icon name="law-star" className="host-tag__icon" />
                        Host
                      </span>
                    )}
                    {p.id === me && <span className="you-tag">(you)</span>}
                  </td>
                  <td className="posse__status-col">
                    <span className={`status-dot ${p.connected ? 'status-dot--on' : ''}`} aria-hidden />
                    <span className="posse__status-text">{p.bot ? 'Bot' : p.connected ? 'Online' : 'Away'}</span>
                    {p.bot && isHost && (
                      <button className="posse__remove" onClick={() => onRemoveBot(p.id)} aria-label={`Remove ${p.name}`} title="Remove bot">
                        ✕
                      </button>
                    )}
                    {!p.connected && p.offlineSince !== null && (
                      <span className="away" title="Removed automatically if they don't come back">
                        {' '}· {formatCountdown(p.offlineSince + room.kickAfterMs - now)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {Array.from({ length: emptyRows }, (_, i) => (
                <tr key={`empty-${i}`} className="posse__empty">
                  <td className="posse__seat">{room.players.length + i + 1}</td>
                  <td colSpan={2}>Waiting for a partner…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="lobby__start stack">
        {isHost ? (
          <>
            <button className="btn btn--primary btn--lg" onClick={onStart} disabled={!enough}>
              Start game
            </button>
            {!enough && <p className="hint">Need at least {MIN_PLAYERS} players — share the link above</p>}
          </>
        ) : (
          <button className="btn btn--primary btn--lg" disabled>
            Waiting for the host…
          </button>
        )}
      </div>
    </main>
  );
}
