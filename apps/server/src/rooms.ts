import { randomInt, randomUUID } from 'node:crypto';
import {
  applyAction,
  createGame,
  MAX_PLAYERS,
  MIN_PLAYERS,
  redactFor,
  type Action,
  type GameEvent,
  type RoomState,
  type Timings,
} from '@cabo/engine';
import type { GameRecord, RoomRecord, Store } from './store';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** Everything the room manager needs to push to clients. */
export interface Outbox {
  roomState(code: string, state: RoomState): void;
  view(sessionId: string, view: ReturnType<typeof redactFor> | null): void;
  /** target is a socket.io room: `r:<code>` (public) or `s:<sessionId>` (private). */
  log(target: string, event: GameEvent): void;
  /** A player left or was kicked: unsubscribe their sockets from the room and tell them. */
  detach(sessionId: string, code: string): void;
}

export class GameError extends Error {}

export const DEFAULT_KICK_AFTER_MS = 5 * 60_000;
/** The peek phase waits for offline players to come back (e.g. a phone reconnecting), up to this long. */
export const DEFAULT_PEEK_HOLD_MS = 60_000;
const PEEK_HOLD_STEP_MS = 5_000;

export class Room {
  connected = new Set<string>();
  /** sessionId -> when they went offline; drives the auto-kick. */
  offlineSince = new Map<string, number>();
  kickTimers = new Map<string, NodeJS.Timeout>();
  game: GameRecord | null = null;
  /** When the current round's peek phase began (to cap how long it waits for offline players). */
  peekStartedAt = 0;
  timer: NodeJS.Timeout | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(public rec: RoomRecord) {}

  has(sessionId: string) {
    return this.rec.players.some((p) => p.sessionId === sessionId);
  }

  toState(kickAfterMs: number): RoomState {
    return {
      code: this.rec.code,
      hostId: this.rec.hostId,
      status: this.rec.status === 'closed' ? 'finished' : this.rec.status,
      roundNo: this.rec.roundNo,
      kickAfterMs,
      players: this.rec.players.map((p) => ({
        id: p.sessionId,
        name: p.name,
        connected: this.connected.has(p.sessionId),
        offlineSince: this.offlineSince.get(p.sessionId) ?? null,
        totalScore: p.totalScore,
      })),
    };
  }

  /** Writes are chained per room so snapshots land in order; failures are logged, not fatal. */
  persist(store: Store, what: 'room' | 'game' | 'both') {
    const room = structuredClone(this.rec);
    const game = this.game;
    this.persistChain = this.persistChain
      .then(async () => {
        if (what !== 'game') await store.saveRoom(room);
        if (what !== 'room' && game) await store.saveGame(game);
      })
      .catch((e) => console.error(`[persist ${room.code}]`, e));
    return this.persistChain;
  }
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private bySession = new Map<string, string>(); // sessionId -> room code

  constructor(
    private store: Store,
    private out: Outbox,
    private timings: Partial<Timings> = {},
    private kickAfterMs = DEFAULT_KICK_AFTER_MS,
    /** Dev/testing only: deal every round from this seed (see CABO_SEED). */
    private fixedSeed: number | null = null,
    private peekHoldMs = DEFAULT_PEEK_HOLD_MS,
  ) {}

  roomOf(sessionId: string): Room | null {
    const code = this.bySession.get(sessionId);
    return code ? this.rooms.get(code) ?? null : null;
  }

  async create(session: { id: string; nickname: string }): Promise<Room> {
    if (this.roomOf(session.id)) throw new GameError('Leave your current room first');
    let code: string;
    do code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    while (this.rooms.has(code));
    const room = new Room({
      id: randomUUID(),
      code,
      hostId: session.id,
      status: 'lobby',
      roundNo: 0,
      dealerIndex: 0,
      players: [{ sessionId: session.id, name: session.nickname, totalScore: 0 }],
    });
    this.rooms.set(code, room);
    this.bySession.set(session.id, code);
    this.markOnline(room, session.id);
    await room.persist(this.store, 'room');
    this.broadcastRoom(room);
    return room;
  }

  async join(session: { id: string; nickname: string }, rawCode: string): Promise<Room> {
    const code = String(rawCode ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room || room.rec.status === 'closed') throw new GameError('Room not found');
    const current = this.roomOf(session.id);
    if (current && current !== room) throw new GameError('Leave your current room first');
    if (!room.has(session.id)) {
      // R27: nobody joins a round in progress; only existing seats may reconnect.
      if (room.rec.status === 'playing') throw new GameError('A round is in progress');
      if (room.rec.players.length >= MAX_PLAYERS) throw new GameError('Room is full');
      room.rec.players.push({ sessionId: session.id, name: session.nickname, totalScore: 0 });
      this.bySession.set(session.id, code);
      await room.persist(this.store, 'room');
    }
    this.markOnline(room, session.id);
    this.broadcastRoom(room);
    this.sendView(room, session.id);
    return room;
  }

  /** Leaving mid-round forfeits your hand; play carries on without you (or ends if one player is left). */
  async leave(sessionId: string): Promise<void> {
    const room = this.roomOf(sessionId);
    if (!room) return;
    await this.dropPlayer(room, sessionId, 'left the game');
  }

  /** Auto-kick: offline longer than kickAfterMs. */
  async kick(sessionId: string): Promise<void> {
    const room = this.roomOf(sessionId);
    if (!room || room.connected.has(sessionId)) return;
    await this.dropPlayer(room, sessionId, 'was away too long and left the room');
  }

  private async dropPlayer(room: Room, sessionId: string, why: string): Promise<void> {
    const name = room.rec.players.find((p) => p.sessionId === sessionId)?.name ?? 'A player';
    if (room.rec.status === 'playing' && room.game?.state.players.some((p) => p.id === sessionId)) {
      try {
        // The engine logs the departure and may end the round (last one standing).
        this.apply(room, { type: 'REMOVE_PLAYER', playerId: sessionId, reason: why });
      } catch (e) {
        console.error('[drop]', e);
      }
    } else {
      this.out.log(`r:${room.rec.code}`, { text: `${name} ${why}` });
    }
    await this.removeFromRoom(room, sessionId);
  }

  private async removeFromRoom(room: Room, sessionId: string): Promise<void> {
    room.rec.players = room.rec.players.filter((p) => p.sessionId !== sessionId);
    room.connected.delete(sessionId);
    this.clearKick(room, sessionId);
    this.bySession.delete(sessionId);
    this.out.view(sessionId, null);
    this.out.detach(sessionId, room.rec.code);
    if (room.rec.players.length === 0) {
      room.rec.status = 'closed';
      if (room.timer) clearTimeout(room.timer);
      this.rooms.delete(room.rec.code);
    } else if (room.rec.hostId === sessionId) {
      room.rec.hostId = room.rec.players[0].sessionId;
    }
    await room.persist(this.store, 'room');
    this.broadcastRoom(room);
  }

  /** Starts round 1, or the next round once the previous one has ended. */
  async start(sessionId: string): Promise<void> {
    const room = this.roomOf(sessionId);
    if (!room) throw new GameError('Not in a room');
    if (room.rec.hostId !== sessionId) throw new GameError('Only the host can start');
    if (room.rec.status === 'playing') throw new GameError('Already playing');
    const n = room.rec.players.length;
    if (n < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players`);
    // R1: dealer rotates left each round.
    room.rec.dealerIndex = room.rec.roundNo === 0 ? 0 : (room.rec.dealerIndex + 1) % n;
    room.rec.roundNo++;
    room.rec.status = 'playing';
    room.peekStartedAt = Date.now();
    room.game = {
      id: randomUUID(),
      roomId: room.rec.id,
      roundNo: room.rec.roundNo,
      state: createGame({
        players: room.rec.players.map((p) => ({ id: p.sessionId, name: p.name })),
        seed: this.fixedSeed ?? randomInt(2 ** 31),
        dealerIndex: room.rec.dealerIndex,
        now: Date.now(),
        timings: this.timings,
      }),
    };
    this.out.log(`r:${room.rec.code}`, { text: `Round ${room.rec.roundNo} dealt. Memorise your two nearest cards, then press Ready.` });
    await room.persist(this.store, 'both');
    this.afterChange(room);
  }

  /**
   * Applies one action. The engine is synchronous and Node runs one socket handler at a
   * time, so actions (including racing snaps) are applied strictly in arrival order.
   */
  act(sessionId: string, action: Action): void {
    const room = this.roomOf(sessionId);
    if (!room?.game || room.rec.status !== 'playing') throw new GameError('No round in progress');
    this.apply(room, action);
  }

  private apply(room: Room, action: Action): void {
    const r = applyAction(room.game!.state, action, Date.now());
    if (!r.ok) {
      if (action.type === 'TICK') return;
      throw new GameError(r.message);
    }
    room.game!.state = r.state;
    for (const e of r.events) {
      if (e.to) this.out.log(`s:${e.to}`, e);
      else this.out.log(`r:${room.rec.code}`, e);
    }
    let what: 'game' | 'both' = 'game';
    if (r.state.phase.kind === 'ended') {
      const scores = r.state.phase.scores;
      for (const p of room.rec.players) p.totalScore += scores[p.sessionId] ?? 0;
      room.rec.status = 'finished';
      what = 'both';
    }
    void room.persist(this.store, what);
    this.afterChange(room);
  }

  private afterChange(room: Room) {
    this.broadcastRoom(room);
    for (const p of room.rec.players) this.sendView(room, p.sessionId);
    this.schedule(room);
  }

  /** R25: one timer per room fires a TICK at the current deadline. */
  private schedule(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    const deadline = room.game?.state.deadline;
    if (deadline == null || room.rec.status !== 'playing') return;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (!room.game) return;
      // Don't start play while someone who hasn't seen their cards is offline (reconnecting):
      // give them a few more seconds, up to peekHoldMs from the start of the round.
      const st = room.game.state;
      const waiting = st.players.some((p) => !p.ready && !room.connected.has(p.id));
      if (st.phase.kind === 'peek' && waiting && Date.now() < room.peekStartedAt + this.peekHoldMs) {
        st.deadline = Date.now() + PEEK_HOLD_STEP_MS;
        for (const p of room.rec.players) this.sendView(room, p.sessionId);
        this.schedule(room);
        return;
      }
      this.apply(room, { type: 'TICK' });
    }, Math.max(0, deadline - Date.now()) + 10);
  }

  setConnected(sessionId: string, connected: boolean) {
    const room = this.roomOf(sessionId);
    if (!room) return;
    if (connected) this.markOnline(room, sessionId);
    else this.markOffline(room, sessionId);
    this.broadcastRoom(room);
  }

  private markOnline(room: Room, sessionId: string) {
    room.connected.add(sessionId);
    this.clearKick(room, sessionId);
  }

  private markOffline(room: Room, sessionId: string, since = Date.now()) {
    room.connected.delete(sessionId);
    this.clearKick(room, sessionId);
    room.offlineSince.set(sessionId, since);
    const delay = Math.max(0, since + this.kickAfterMs - Date.now());
    room.kickTimers.set(
      sessionId,
      setTimeout(() => void this.kick(sessionId).catch((e) => console.error('[kick]', e)), delay),
    );
  }

  private clearKick(room: Room, sessionId: string) {
    const t = room.kickTimers.get(sessionId);
    if (t) clearTimeout(t);
    room.kickTimers.delete(sessionId);
    room.offlineSince.delete(sessionId);
  }

  sendView(room: Room, sessionId: string) {
    this.out.view(sessionId, room.game ? redactFor(room.game.state, sessionId) : null);
  }

  broadcastRoom(room: Room) {
    this.out.roomState(room.rec.code, room.toState(this.kickAfterMs));
  }

  /** Rebuild in-memory rooms after a restart. Players reconnect with their tokens. */
  async restore(): Promise<number> {
    const rows = await this.store.loadOpenRooms();
    const now = Date.now();
    for (const { room: rec, game } of rows) {
      const room = new Room(rec);
      if (game && rec.status !== 'lobby') {
        room.game = game;
        // Give everyone time to reconnect before timers resume.
        if (game.state.deadline !== null) game.state.deadline = Math.max(game.state.deadline, now + 15_000);
      }
      this.rooms.set(rec.code, room);
      room.peekStartedAt = now;
      for (const p of rec.players) {
        this.bySession.set(p.sessionId, rec.code);
        this.markOffline(room, p.sessionId, now); // everyone starts offline; reconnecting clears it
      }
      this.schedule(room);
    }
    return rows.length;
  }

  shutdown() {
    for (const room of this.rooms.values()) {
      if (room.timer) clearTimeout(room.timer);
      for (const t of room.kickTimers.values()) clearTimeout(t);
    }
  }
}
