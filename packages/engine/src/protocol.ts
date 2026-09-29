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

/** Host-chosen game settings (lobby ⚙). Times in ms. */
export interface GameSettings {
  /** A player whose running total reaches this at the end of a round loses; the game is over. null = no limit. */
  maxPoints: number | null;
  /** Memorise time at the start of a round. */
  peekMs: number;
  /** Time for a whole turn ("think time"). */
  turnMs: number;
  /** Time for a special card's choice, or to give a card after snapping. */
  choiceMs: number;
  /** Snap window. */
  snapMs: number;
}

/** Allowed values for each setting (min, max, step). */
export const SETTING_LIMITS = {
  maxPoints: { min: 30, max: 500, step: 10 },
  peekMs: { min: 10_000, max: 60_000, step: 5_000 },
  turnMs: { min: 15_000, max: 120_000, step: 5_000 },
  choiceMs: { min: 5_000, max: 30_000, step: 1_000 },
  snapMs: { min: 2_000, max: 8_000, step: 500 },
} as const;

export const DEFAULT_MAX_POINTS = 100;

/** Shown to everyone when the game ends: players by final total, lowest first. */
export interface FinalStandings {
  standings: { id: string; name: string; total: number }[];
  winners: string[];
  rounds: number;
  /** Players who reached the points limit (the game ended because of them). */
  losers: string[];
  /** `limit`: someone reached the points limit; `host`: the host ended it. */
  reason: 'limit' | 'host';
}

export interface RoomState {
  code: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  roundNo: number;
  kickAfterMs: number;
  players: RoomPlayerInfo[];
  settings: GameSettings;
  /** Between rounds: players whose total has reached the points limit. Non-empty = game over. */
  limitHit: string[];
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
  /** Host only, not mid-round. Any subset of the settings; values outside SETTING_LIMITS are refused. */
  'room:settings': (req: Partial<GameSettings>, ack: (r: Ack) => void) => void;
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
