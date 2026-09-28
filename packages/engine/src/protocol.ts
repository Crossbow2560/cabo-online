import type { Action, GameEvent } from './state';
import type { PlayerView } from './view';

/** Actions a client may send. The server fills in `playerId` from the session. */
export type ClientAction = Exclude<Action, { type: 'TICK' } | { type: 'SNAP' } | { type: 'REMOVE_PLAYER' }> extends infer A
  ? A extends { playerId: string }
    ? Omit<A, 'playerId'>
    : never
  : never;

export interface SnapRequest {
  windowId: number;
  ownerId: string;
  slot: number;
}

export interface RoomPlayerInfo {
  id: string;
  name: string;
  connected: boolean;
  /** Epoch ms when this player went offline; they are kicked after `kickAfterMs`. */
  offlineSince: number | null;
  totalScore: number;
}

export interface RoomState {
  code: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  roundNo: number;
  kickAfterMs: number;
  players: RoomPlayerInfo[];
}

export type Ack<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export interface ServerToClient {
  'room:state': (room: RoomState) => void;
  'game:view': (view: PlayerView | null) => void;
  'game:log': (event: GameEvent & { at: number }) => void;
  'session:replaced': () => void;
}

export interface ClientToServer {
  'room:create': (ack: (r: Ack<{ code: string }>) => void) => void;
  'room:join': (req: { code: string }, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:leave': (ack: (r: Ack) => void) => void;
  'room:start': (ack: (r: Ack) => void) => void;
  'game:action': (action: ClientAction, ack: (r: Ack) => void) => void;
  'game:snap': (req: SnapRequest, ack: (r: Ack) => void) => void;
}
