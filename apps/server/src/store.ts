import postgres from 'postgres';
import type { GameState } from '@cabo/engine';

export interface SessionRecord {
  id: string;
  nickname: string;
}

export type RoomStatus = 'lobby' | 'playing' | 'finished' | 'closed';

export interface RoomRecord {
  id: string;
  code: string;
  hostId: string;
  status: RoomStatus;
  roundNo: number;
  dealerIndex: number;
  players: { sessionId: string; name: string; totalScore: number; bot?: boolean }[];
}

export interface GameRecord {
  id: string;
  roomId: string;
  roundNo: number;
  state: GameState;
}

export interface Store {
  createSession(id: string, tokenHash: string, nickname: string): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  saveRoom(room: RoomRecord): Promise<void>;
  saveGame(game: GameRecord): Promise<void>;
  /** Rooms that were open when the server stopped, with their latest game. */
  loadOpenRooms(): Promise<{ room: RoomRecord; game: GameRecord | null }[]>;
  close(): Promise<void>;
}

/** Used when DATABASE_URL is not set (local dev / tests). Nothing survives a restart. */
export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRecord>();
  private rooms = new Map<string, RoomRecord>();
  private games = new Map<string, GameRecord>();

  async createSession(id: string, tokenHash: string, nickname: string) {
    this.sessions.set(tokenHash, { id, nickname });
  }
  async findSession(tokenHash: string) {
    return this.sessions.get(tokenHash) ?? null;
  }
  async saveRoom(room: RoomRecord) {
    this.rooms.set(room.id, structuredClone(room));
  }
  async saveGame(game: GameRecord) {
    this.games.set(game.roomId, structuredClone(game));
  }
  async loadOpenRooms() {
    return [...this.rooms.values()]
      .filter((r) => r.status !== 'closed')
      .map((room) => ({ room: structuredClone(room), game: structuredClone(this.games.get(room.id) ?? null) }));
  }
  async close() {}
}

export class PgStore implements Store {
  private sql: postgres.Sql;

  constructor(url: string) {
    // Supabase's transaction pooler (port 6543) doesn't support prepared statements.
    const pooled = new URL(url).port === '6543';
    this.sql = postgres(url, { max: 5, prepare: !pooled, onnotice: () => {} });
  }

  async createSession(id: string, tokenHash: string, nickname: string) {
    await this.sql`insert into guest_sessions (id, token_hash, nickname) values (${id}, ${tokenHash}, ${nickname})`;
  }

  async findSession(tokenHash: string) {
    const rows = await this.sql<SessionRecord[]>`select id, nickname from guest_sessions where token_hash = ${tokenHash}`;
    return rows[0] ?? null;
  }

  async saveRoom(room: RoomRecord) {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into rooms (id, code, host_session_id, status, round_no, dealer_index)
        values (${room.id}, ${room.code}, ${room.hostId}, ${room.status}, ${room.roundNo}, ${room.dealerIndex})
        on conflict (id) do update set
          host_session_id = excluded.host_session_id, status = excluded.status,
          round_no = excluded.round_no, dealer_index = excluded.dealer_index, updated_at = now()`;
      await tx`delete from room_players where room_id = ${room.id}`;
      for (const [seat, p] of room.players.entries()) {
        await tx`insert into room_players (room_id, session_id, seat, total_score)
                 values (${room.id}, ${p.sessionId}, ${seat}, ${p.totalScore})`;
      }
    });
  }

  async saveGame(game: GameRecord) {
    const ended = game.state.phase.kind === 'ended';
    await this.sql`
      insert into games (id, room_id, round_no, state_snapshot, version, ended_at)
      values (${game.id}, ${game.roomId}, ${game.roundNo}, ${this.sql.json(game.state as never)}, ${game.state.version},
              ${ended ? this.sql`now()` : null})
      on conflict (id) do update set
        state_snapshot = excluded.state_snapshot, version = excluded.version, ended_at = excluded.ended_at
      where games.version <= excluded.version`;
  }

  async loadOpenRooms() {
    const rooms = await this.sql<
      { id: string; code: string; host_session_id: string; status: RoomStatus; round_no: number; dealer_index: number }[]
    >`select id, code, host_session_id, status, round_no, dealer_index from rooms
      where status <> 'closed' and updated_at > now() - interval '1 day'`;
    const out: { room: RoomRecord; game: GameRecord | null }[] = [];
    for (const r of rooms) {
      // Bot sessions are marked by a `bot:` token hash (see RoomManager.addBot).
      const players = await this.sql<{ session_id: string; nickname: string; total_score: number; bot: boolean }[]>`
        select rp.session_id, s.nickname, rp.total_score, s.token_hash like 'bot:%' as bot from room_players rp
        join guest_sessions s on s.id = rp.session_id
        where rp.room_id = ${r.id} order by rp.seat`;
      const games = await this.sql<{ id: string; round_no: number; state_snapshot: GameState }[]>`
        select id, round_no, state_snapshot from games where room_id = ${r.id} order by round_no desc limit 1`;
      out.push({
        room: {
          id: r.id,
          code: r.code.trim(),
          hostId: r.host_session_id,
          status: r.status,
          roundNo: r.round_no,
          dealerIndex: r.dealer_index,
          players: players.map((p) => ({ sessionId: p.session_id, name: p.nickname, totalScore: p.total_score, bot: p.bot })),
        },
        game: games[0] ? { id: games[0].id, roomId: r.id, roundNo: games[0].round_no, state: games[0].state_snapshot } : null,
      });
    }
    return out;
  }

  async close() {
    await this.sql.end();
  }
}
