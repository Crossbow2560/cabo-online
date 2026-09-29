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
  /** How long after this client saw the window open the player tapped. */
  reactionMs?: number;
}

/** Server bot difficulty presets (timings and snapping; see apps/server/src/bot.ts). */
export const BOT_LEVELS = ['beginner', 'novice', 'intermediate', 'expert'] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

export interface RoomPlayerInfo {
  id: string;
  name: string;
  connected: boolean;
  /** A server-driven bot (added by the host). */
  bot: boolean;
  /** Set for bots. */
  botLevel: BotLevel | null;
  /** Epoch ms when this player went offline; they are kicked after `kickAfterMs`. */
  offlineSince: number | null;
  totalScore: number;
}

/** Shown to everyone when the host ends the game: players by final total, lowest first. */
export interface FinalStandings {
  standings: { id: string; name: string; total: number }[];
  winners: string[];
  rounds: number;
}

export interface RoomState {
  code: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  roundNo: number;
  kickAfterMs: number;
  players: RoomPlayerInfo[];
  /** People watching without a seat. They get the public view only (every hand face-down). */
  spectators: { id: string; name: string }[];
  /** Mid-round pause: timers and bots are frozen and no moves are accepted until someone resumes. */
  paused: { byId: string; byName: string } | null;
  /** The previous game's final standings (set when the host ends a game; cleared on the next deal). */
  final: FinalStandings | null;
}

export type Ack<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export interface ServerToClient {
  /** null = you're not seated in any room (sent on every connect, and when you're removed). */
  'room:state': (room: RoomState | null) => void;
  'game:view': (view: PlayerView | null) => void;
  'game:log': (event: GameEvent & { at: number }) => void;
  'session:replaced': () => void;
}

export interface ClientToServer {
  'room:create': (ack: (r: Ack<{ code: string }>) => void) => void;
  'room:join': (req: { code: string }, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:leave': (ack: (r: Ack) => void) => void;
  /** Watch a room without a seat (any time, even mid-round). `room:leave` stops watching. */
  'room:spectate': (req: { code: string }, ack: (r: Ack<{ code: string }>) => void) => void;
  'room:start': (ack: (r: Ack) => void) => void;
  /** Host only, between rounds: finish the game, show final standings, back to the lobby. */
  'room:end': (ack: (r: Ack) => void) => void;
  /** Anyone seated, mid-round (not during a snap window). */
  'room:pause': (ack: (r: Ack) => void) => void;
  'room:resume': (ack: (r: Ack) => void) => void;
  /** Host only, between rounds. */
  'room:addBot': (req: { level: BotLevel }, ack: (r: Ack) => void) => void;
  'room:removeBot': (req: { id: string }, ack: (r: Ack) => void) => void;
  'game:action': (action: ClientAction, ack: (r: Ack) => void) => void;
  'game:snap': (req: SnapRequest, ack: (r: Ack) => void) => void;
  /** This client's snap window ended without a snap. */
  'game:snapPass': (req: { windowId: number }, ack: (r: Ack) => void) => void;
}
