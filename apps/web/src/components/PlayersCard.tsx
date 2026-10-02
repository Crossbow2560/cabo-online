import type { RoomState } from '@cabo/engine';
import { formatCountdown } from '../lib/useNow';
import { Icon } from './Icon';

/** Small collapsible roster: online/away countdown and running totals. */
export function PlayersCard({ room, me, now, open, onToggle }: {
  room: RoomState;
  me: string;
  now: number;
  /** Open state lives in Game, so on phones opening this closes the Log (they don't fit side by side). */
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="dock dock--left">
      {open && (
        <div className="panel mini-card" id="players-card">
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
              </li>
            ))}
          </ul>
        </div>
      )}
      <button className="btn btn--cream btn--sm chip" aria-expanded={open} aria-controls="players-card" onClick={onToggle}>
        Posse ({room.players.length}) {open ? '▾' : '▴'}
      </button>
    </div>
  );
}
