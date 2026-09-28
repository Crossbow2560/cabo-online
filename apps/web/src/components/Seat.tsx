import type { PlayerView, RoomState } from '@cabo/engine';
import { formatCountdown } from '../lib/useNow';
import { Hand, type SlotState } from './Hand';

type SeatPlayer = PlayerView['players'][number];

/** An opponent around the table: name plate + mini hand. */
export function Seat({ player, view, room, now, arc, state, onCard }: {
  player: SeatPlayer;
  view: PlayerView;
  room: RoomState;
  now: number;
  /** 0 at the far (top) middle of the table, 1 at the ends. */
  arc: number;
  state: (slot: number) => SlotState;
  onCard: (slot: number) => void;
}) {
  const info = room.players.find((p) => p.id === player.id);
  const turn = view.currentPlayerId === player.id && view.phase !== 'ended' && view.phase !== 'peek';
  return (
    <div className={`seat ${turn ? 'seat--turn' : ''}`} style={{ '--arc': arc } as React.CSSProperties}>
      <div className="seat__plate">
        <span className={`status-dot ${info?.connected ? 'status-dot--on' : ''}`} aria-hidden />
        <span className="seat__name">{player.name}</span>
        {view.dealerId === player.id && <span className="chip-d" title="Dealer">D</span>}
        {view.caboCalledBy === player.id && <span className="chip-cabo">CABO</span>}
      </div>
      <div className="seat__sub">
        {view.phase === 'peek' ? (player.ready ? 'ready ✓' : 'memorising…') : turn ? 'their turn' : ' '}
        {info && !info.connected && info.offlineSince !== null && (
          <span className="away"> · away {formatCountdown(info.offlineSince + room.kickAfterMs - now)}</span>
        )}
      </div>
      <Hand slots={player.slots} size="sm" state={state} onCard={onCard} ownerName={player.name} />
    </div>
  );
}
