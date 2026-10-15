import type { RoomState } from '@cabo/engine';
import { formatCountdown } from '../lib/useNow';
import { Icon } from './Icon';
import { useKickConfirm } from './KickConfirm';

/** Small collapsible roster: online/away countdown and running totals. The host can remove people here. */
export function PlayersCard({ room, me, now, open, onToggle, onKick }: {
  room: RoomState;
  me: string;
  now: number;
  /** Open state lives in Game, so on phones opening this closes the Log (they don't fit side by side). */
  open: boolean;
  onToggle: () => void;
  /** Host: remove a player, bot or spectator. */
  onKick: (id: string) => void;
}) {
  const isHost = room.hostId === me;
  const kick = useKickConfirm(onKick, room.status === 'playing');
  const remove = (id: string, name: string, opts: { bot?: boolean; spectator?: boolean }) =>
    isHost && id !== me ? (
      <button className="roster__kick" onClick={() => kick.ask(id, name, opts)} aria-label={`Remove ${name}`} title={opts.bot ? 'Remove bot' : 'Remove from room'}>
        ✕
      </button>
    ) : (
      isHost && <span aria-hidden />
    );
  return (
    <div className="dock dock--left">
      {open && (
        <div className={`panel mini-card ${isHost ? 'roster--host' : ''}`} id="players-card">
          <div className="mini-card__head">
            <span>Posse</span>
            <span className="mini-card__sub">Total</span>
          </div>
          <ul className="roster">
            {room.players.map((p) => (
              <li key={p.id} className="roster__row">
                <span className={`status-dot ${p.connected ? 'status-dot--on' : ''}`} aria-hidden />
                <span className="roster__name">
                  {p.name}
                  {p.id === room.hostId && <Icon name="law-star" className="roster__star" />}
                  {p.id === me && <span className="you-tag">(you)</span>}
                  {!p.connected && p.offlineSince !== null && (
                    <span className="away"> · away {formatCountdown(p.offlineSince + room.kickAfterMs - now)}</span>
                  )}
                </span>
                <span className="roster__score">{p.totalScore}</span>
                {remove(p.id, p.name, { bot: p.bot })}
              </li>
            ))}
          </ul>
          {room.spectators.length > 0 && (
            <>
              <div className="mini-card__head roster__watch-head">
                <span>Watching</span>
              </div>
              <ul className="roster">
                {room.spectators.map((s) => (
                  <li key={s.id} className="roster__row">
                    <Icon name="binoculars" className="watch-icon" />
                    <span className="roster__name">
                      {s.name}
                      {s.id === me && <span className="you-tag">(you)</span>}
                    </span>
                    <span />
                    {remove(s.id, s.name, { spectator: true })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {kick.dialog}
      <button className="btn btn--cream btn--sm chip" aria-expanded={open} aria-controls="players-card" onClick={onToggle}>
        Posse ({room.players.length}) {open ? '▾' : '▴'}
      </button>
    </div>
  );
}
