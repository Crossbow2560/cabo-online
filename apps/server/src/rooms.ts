import { randomInt, randomUUID } from 'node:crypto';
import {
  applyAction,
  BOT_LEVELS,
  type BotLevel,
  type FinalStandings,
  createGame,
  MAX_PLAYERS,
  MIN_PLAYERS,
  redactFor,
  type Action,
  type GameEvent,
  type RoomState,
  type Timings,
} from '@cabo/engine';
import { BOT_PRESETS, BotBrain } from './bot';
import type { GameRecord, RoomRecord, Store } from './store';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const BOT_NAMES = ['Dusty', 'Calamity', 'Doc', 'Sundance', 'Rattler', 'Tumbleweed', 'Buckshot', 'Belle', 'Cactus', 'Maverick'];
/** Everyone memorises for a few seconds; after that, a bot's level sets its pace (BOT_PRESETS). */
const BOT_READY_DELAY: [number, number] = [2000, 4000];

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

interface Bot {
  brain: BotBrain;
  level: BotLevel;
  timer: NodeJS.Timeout | null;
  pending: Action | null;
  version: number;
}

export const DEFAULT_KICK_AFTER_MS = 5 * 60_000;
/** How long past a snap window the server waits for slow connections' snaps (or "no snap"). */
export const DEFAULT_SNAP_GRACE_MS = 1_500;
/** Reported reaction times below this aren't believed (no human taps faster). */
export const MIN_REACTION_MS = 120;
export const MAX_SPECTATORS = 20;
/** A spectator whose connection drops keeps their place this long (e.g. a page reload). */
export const SPECTATOR_GRACE_MS = 60_000;
/** The peek phase waits for offline players to come back (e.g. a phone reconnecting), up to this long. */
export const DEFAULT_PEEK_HOLD_MS = 60_000;
const PEEK_HOLD_STEP_MS = 5_000;

/**
 * One snap window's snaps, gathered before any is applied. Each client reports how long after it
 * *saw* the window it tapped (or that it didn't), so a slow connection doesn't cost the race.
 */
interface SnapBatch {
  windowId: number;
  openedAt: number;
  deadline: number;
  /** Humans online when the window opened; the server waits for each one's snap or pass. */
  waitingFor: Set<string>;
  /** Who has snapped or passed (one snap per player per window). */
  done: Set<string>;
  entries: { playerId: string; ownerId: string; slot: number; at: number; order: number }[];
}

export class Room {
  connected = new Set<string>();
  /** Watching without a seat: sessionId → nickname. In memory only. */
  spectators = new Map<string, string>();
  /** Mid-round pause (not persisted: a restart resumes play). */
  paused: { byId: string; byName: string; at: number } | null = null;
  /** Final standings of the last game ended by the host, until the next deal. */
  final: FinalStandings | null = null;
  snaps: SnapBatch | null = null;
  /** True while a snap batch is being replayed (so the replay doesn't open a new batch). */
  resolvingSnaps = false;
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
        bot: !!p.bot,
        botLevel: p.bot ? p.botLevel ?? 'intermediate' : null,
        offlineSince: this.offlineSince.get(p.sessionId) ?? null,
        totalScore: p.totalScore,
      })),
      spectators: [...this.spectators].map(([id, name]) => ({ id, name })),
      paused: this.paused ? { byId: this.paused.byId, byName: this.paused.byName } : null,
      final: this.final,
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
  private watching = new Map<string, string>(); // spectator sessionId -> room code
  private spectatorTimers = new Map<string, NodeJS.Timeout>();
  /** Server-side bot players: their brain and the pending move. */
  /** Bot moves the engine refused (tests assert this stays empty). */
  readonly botRejections: string[] = [];
  private bots = new Map<string, Bot>();

  constructor(
    private store: Store,
    private out: Outbox,
    private timings: Partial<Timings> = {},
    private kickAfterMs = DEFAULT_KICK_AFTER_MS,
    /** Dev/testing only: deal every round from this seed (see CABO_SEED). */
    private fixedSeed: number | null = null,
    private peekHoldMs = DEFAULT_PEEK_HOLD_MS,
    /** Multiplies bot "thinking" delays (tests use a tiny value). */
    private botPace = 1,
    private snapGraceMs = DEFAULT_SNAP_GRACE_MS,
  ) {}

  roomOf(sessionId: string): Room | null {
    const code = this.bySession.get(sessionId);
    return code ? this.rooms.get(code) ?? null : null;
  }

  /** The room a session is watching (not seated in). */
  spectatingOf(sessionId: string): Room | null {
    const code = this.watching.get(sessionId);
    return code ? this.rooms.get(code) ?? null : null;
  }

  /** Watch a room by code, at any stage. Spectators see only public information. */
  spectate(session: { id: string; nickname: string }, rawCode: string): Room {
    const code = String(rawCode ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room || room.rec.status === 'closed') throw new GameError('Room not found');
    if (this.roomOf(session.id)) throw new GameError('Leave your current room first');
    if (!room.spectators.has(session.id) && room.spectators.size >= MAX_SPECTATORS) throw new GameError('Too many spectators');
    const current = this.spectatingOf(session.id);
    if (current && current !== room) this.stopSpectating(session.id);
    room.spectators.set(session.id, session.nickname);
    this.watching.set(session.id, code);
    this.spectatorOnline(session.id, true);
    this.broadcastRoom(room);
    this.sendView(room, session.id);
    return room;
  }

  /** Leaving as a spectator. Returns whether they were watching. */
  stopSpectating(sessionId: string): boolean {
    const room = this.spectatingOf(sessionId);
    this.watching.delete(sessionId);
    this.spectatorOnline(sessionId, true); // clears any pending removal
    if (!room) return false;
    room.spectators.delete(sessionId);
    this.out.view(sessionId, null);
    this.out.detach(sessionId, room.rec.code);
    this.broadcastRoom(room);
    return true;
  }

  /** A spectator's connection dropped (removed after a grace period) or came back. */
  spectatorOnline(sessionId: string, online: boolean) {
    const t = this.spectatorTimers.get(sessionId);
    if (t) clearTimeout(t);
    this.spectatorTimers.delete(sessionId);
    if (!online && this.watching.has(sessionId)) {
      this.spectatorTimers.set(sessionId, setTimeout(() => this.stopSpectating(sessionId), SPECTATOR_GRACE_MS));
    }
  }

  async create(session: { id: string; nickname: string }): Promise<Room> {
    if (this.roomOf(session.id)) throw new GameError('Leave your current room first');
    this.stopSpectating(session.id);
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
    if (!room.has(session.id) && room.rec.status === 'playing') throw new GameError('A round is in progress');
    this.stopSpectating(session.id); // taking a seat ends watching
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

  /** Host only, between rounds: seat a server-driven bot. */
  async addBot(hostId: string, level: BotLevel = 'intermediate'): Promise<void> {
    if (!BOT_LEVELS.includes(level)) throw new GameError('Unknown bot level');
    const room = this.hostRoom(hostId);
    if (room.rec.players.length >= MAX_PLAYERS) throw new GameError('Room is full');
    const taken = new Set(room.rec.players.map((p) => p.name));
    const base = BOT_NAMES.find((n) => !taken.has(`${n} (bot)`)) ?? `Bot ${room.rec.players.length + 1}`;
    const name = `${base} (bot)`;
    const id = randomUUID();
    // A session row keeps the room_players foreign key happy. Its token hash is not a sha256,
    // so no client can ever authenticate as a bot.
    await this.store.createSession(id, `bot:${level}:${id}`, name);
    room.rec.players.push({ sessionId: id, name, totalScore: 0, bot: true, botLevel: level });
    this.bySession.set(id, room.rec.code);
    this.bots.set(id, newBot(id, level));
    this.markOnline(room, id);
    this.out.log(`r:${room.rec.code}`, { text: `${name} joined the posse` });
    await room.persist(this.store, 'room');
    this.broadcastRoom(room);
  }

  /** Host only, between rounds: remove a bot. */
  async removeBot(hostId: string, botId: string): Promise<void> {
    const room = this.hostRoom(hostId);
    if (!room.rec.players.some((p) => p.sessionId === botId && p.bot)) throw new GameError('No such bot');
    await this.dropPlayer(room, botId, 'was sent packing');
  }

  private hostRoom(hostId: string): Room {
    const room = this.roomOf(hostId);
    if (!room) throw new GameError('Not in a room');
    if (room.rec.hostId !== hostId) throw new GameError('Only the host can manage bots');
    if (room.rec.status === 'playing') throw new GameError('Wait for the round to end');
    return room;
  }

  /** Leaving mid-round forfeits your hand; play carries on without you (or ends if one player is left). */
  async leave(sessionId: string): Promise<void> {
    if (this.stopSpectating(sessionId)) return;
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
    this.dropBot(sessionId);
    if (room.snaps?.waitingFor.delete(sessionId)) this.settleSnaps(room);
    this.out.view(sessionId, null);
    this.out.detach(sessionId, room.rec.code);
    const humans = room.rec.players.filter((p) => !p.bot);
    if (humans.length === 0) {
      // Bots never play on their own: the last human leaving closes the room.
      for (const p of room.rec.players) {
        this.bySession.delete(p.sessionId);
        this.dropBot(p.sessionId);
      }
      room.rec.players = [];
      room.rec.status = 'closed';
      // Nothing left to watch.
      for (const id of [...room.spectators.keys()]) this.stopSpectating(id);
      if (room.timer) clearTimeout(room.timer);
      this.rooms.delete(room.rec.code);
    } else if (room.rec.hostId === sessionId) {
      room.rec.hostId = humans[0].sessionId;
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
    room.final = null;
    room.paused = null;
    for (const p of room.rec.players) this.bots.get(p.sessionId)?.brain.reset();
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
    if (room.paused) throw new GameError('The game is paused');
    this.apply(room, action);
  }

  /** Anyone seated may pause a round; timers and bots freeze until someone resumes. */
  pause(sessionId: string): void {
    const room = this.roomOf(sessionId);
    if (!room?.game || room.rec.status !== 'playing') throw new GameError('No round in progress');
    if (room.paused) throw new GameError('Already paused');
    // Each player times a snap window on their own screen, so it can't be frozen fairly.
    if (room.game.state.phase.kind === 'snap' || room.snaps || room.resolvingSnaps) throw new GameError('Wait for the snap window to close');
    const name = room.rec.players.find((p) => p.sessionId === sessionId)?.name ?? 'Someone';
    room.paused = { byId: sessionId, byName: name, at: Date.now() };
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    for (const p of room.rec.players) {
      const bot = this.bots.get(p.sessionId);
      if (bot) this.cancelBot(bot);
    }
    this.out.log(`r:${room.rec.code}`, { text: `${name} paused the game` });
    this.broadcastRoom(room);
  }

  resume(sessionId: string): void {
    const room = this.roomOf(sessionId);
    if (!room?.paused) throw new GameError('The game isn\'t paused');
    const st = room.game?.state;
    // Everyone gets back exactly the time they had left.
    const held = Date.now() - room.paused.at;
    if (st && st.deadline !== null) st.deadline += held;
    room.peekStartedAt += held;
    room.paused = null;
    const name = room.rec.players.find((p) => p.sessionId === sessionId)?.name ?? 'Someone';
    this.out.log(`r:${room.rec.code}`, { text: `${name} resumed the game` });
    this.afterChange(room);
  }

  /** Host only, between rounds: the game is over. Show final standings and go back to the lobby. */
  async end(sessionId: string): Promise<void> {
    const room = this.roomOf(sessionId);
    if (!room) throw new GameError('Not in a room');
    if (room.rec.hostId !== sessionId) throw new GameError('Only the host can end the game');
    if (room.rec.status !== 'finished') throw new GameError('Finish the round first');
    const standings = room.rec.players
      .map((p) => ({ id: p.sessionId, name: p.name, total: p.totalScore }))
      .sort((a, b) => a.total - b.total);
    const best = standings[0]?.total;
    room.final = { standings, winners: standings.filter((s) => s.total === best).map((s) => s.id), rounds: room.rec.roundNo };
    room.rec.status = 'lobby';
    room.rec.roundNo = 0;
    room.rec.dealerIndex = 0;
    for (const p of room.rec.players) p.totalScore = 0;
    room.game = null;
    const names = room.final.winners.map((id) => standings.find((s) => s.id === id)!.name).join(' & ');
    this.out.log(`r:${room.rec.code}`, { text: `Game over after ${room.final.rounds} round(s). ${names} ${room.final.winners.length > 1 ? 'win' : 'wins'}!` });
    await room.persist(this.store, 'room');
    this.afterChange(room);
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
      for (const p of room.rec.players) if (p.bot) this.bots.get(p.sessionId)?.brain.observe(e);
    }
    let what: 'game' | 'both' = 'game';
    if (r.state.phase.kind === 'ended') {
      const scores = r.state.phase.scores;
      for (const p of room.rec.players) p.totalScore += scores[p.sessionId] ?? 0;
      room.rec.status = 'finished';
      room.paused = null;
      what = 'both';
    }
    void room.persist(this.store, what);
    this.afterChange(room);
  }

  private afterChange(room: Room) {
    this.broadcastRoom(room);
    for (const p of room.rec.players) this.sendView(room, p.sessionId);
    for (const id of room.spectators.keys()) this.sendView(room, id); // public view: no seat, no cards
    this.schedule(room);
    this.scheduleBots(room);
  }

  /** Each bot looks at its own redacted view and queues its next move after a human-like pause. */
  private scheduleBots(room: Room) {
    const st = room.game?.state;
    for (const p of room.rec.players) {
      const bot = this.bots.get(p.sessionId);
      if (!bot) continue;
      if (!st || room.rec.status !== 'playing' || room.paused) {
        this.cancelBot(bot);
        continue;
      }
      // A queued snap stays valid for its whole window, even if others act meanwhile.
      const pending = bot.pending;
      if (pending?.type === 'SNAP' && st.phase.kind === 'snap' && st.phase.windowId === pending.windowId) continue;
      if (pending && bot.version === st.version) continue;
      this.cancelBot(bot);
      const action = bot.brain.decide(redactFor(st, p.sessionId));
      if (!action) continue;
      const preset = BOT_PRESETS[bot.level];
      // Lower levels don't always notice a match (the brain won't retry this window).
      if (action.type === 'SNAP' && Math.random() >= preset.snap) continue;
      const [lo, hi] = action.type === 'READY' ? BOT_READY_DELAY : action.type === 'SNAP' ? preset.snapDelay : preset.think;
      bot.pending = action;
      bot.version = st.version;
      bot.timer = setTimeout(() => {
        bot.timer = null;
        bot.pending = null;
        this.botAct(room, p.sessionId, action);
      }, (lo + Math.random() * (hi - lo)) * this.botPace);
    }
  }

  private botAct(room: Room, botId: string, action: Action) {
    if (!room.game || room.rec.status !== 'playing' || !this.bots.has(botId)) return;
    if (action.type === 'SNAP') {
      // Server-side, so its timing is exact: it snaps "now", into the window's batch.
      const b = room.snaps;
      if (b && b.windowId === action.windowId && !b.done.has(botId) && !room.resolvingSnaps) {
        this.recordSnap(room, botId, action.ownerId, action.slot, Date.now());
      }
      return;
    }
    try {
      this.apply(room, action);
    } catch (e) {
      if (!(e instanceof GameError)) return;
      if (e.message !== 'Game state changed, try again' && !e.message.startsWith('Too slow')) {
        this.botRejections.push(`${action.type}: ${e.message}`);
      }
      // The table moved on or the move was refused: fall back to the plainest legal move.
      const kind = room.game.state.phase.kind;
      const fallback = kind === 'drawn' ? 'DISCARD_DRAWN' : kind === 'choose' ? 'DRAW_STOCK' : kind === 'ability' || kind === 'give' ? 'SKIP' : null;
      if (!fallback) return this.scheduleBots(room);
      try {
        this.apply(room, { type: fallback, playerId: botId } as Action);
      } catch {
        this.scheduleBots(room); // not our move after all; wait for the next change
      }
    }
  }

  private cancelBot(bot: Bot) {
    if (bot.timer) clearTimeout(bot.timer);
    bot.timer = null;
    bot.pending = null;
  }

  private dropBot(id: string) {
    const bot = this.bots.get(id);
    if (!bot) return;
    this.cancelBot(bot);
    this.bots.delete(id);
  }

  /** R25: one timer per room fires a TICK at the current deadline. */
  private schedule(room: Room) {
    if (room.resolvingSnaps) return; // resolveSnaps reschedules when it's done
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    if (room.paused) return; // resume() reschedules with the time that was left
    const deadline = room.game?.state.deadline;
    if (deadline == null || room.rec.status !== 'playing') {
      room.snaps = null;
      return;
    }
    const st = room.game!.state;
    if (st.phase.kind === 'snap') {
      if (room.snaps?.windowId !== st.phase.windowId) {
        room.snaps = {
          windowId: st.phase.windowId,
          openedAt: deadline - st.timings.snapMs,
          deadline,
          waitingFor: new Set(st.players.filter((p) => room.connected.has(p.id) && !this.bots.has(p.id)).map((p) => p.id)),
          done: new Set(),
          entries: [],
        };
      }
      return this.settleSnaps(room);
    }
    room.snaps = null;
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

  /** A player's snap: queued until the window's snaps are resolved together. */
  snap(sessionId: string, req: { windowId: number; ownerId: string; slot: number; reactionMs?: number }): void {
    const room = this.roomOf(sessionId);
    const b = room?.snaps;
    if (!room || !b || b.windowId !== req.windowId || room.resolvingSnaps) throw new GameError('Too slow — the snap window is closed');
    if (room.paused) throw new GameError('The game is paused');
    if (b.done.has(sessionId)) throw new GameError('You already snapped this time');
    const elapsed = Date.now() - b.openedAt;
    // Trust the reported reaction time only within bounds: not faster than a human, and not
    // later than the moment it actually reached us. No report (old client): arrival time.
    const claimed = Number.isFinite(req.reactionMs) ? req.reactionMs! : elapsed;
    const reaction = Math.min(Math.max(claimed, MIN_REACTION_MS), elapsed);
    this.recordSnap(room, sessionId, req.ownerId, req.slot, b.openedAt + reaction);
  }

  /** "My snap window ended and I didn't snap." Lets the window resolve without waiting out the grace. */
  passSnap(sessionId: string, windowId: number): void {
    const room = this.roomOf(sessionId);
    const b = room?.snaps;
    if (!room || !b || b.windowId !== windowId) return;
    b.done.add(sessionId);
    this.settleSnaps(room);
  }

  private recordSnap(room: Room, playerId: string, ownerId: string, slot: number, at: number) {
    const b = room.snaps!;
    b.entries.push({ playerId, ownerId, slot, at, order: b.entries.length });
    b.done.add(playerId);
    this.settleSnaps(room);
  }

  /** Resolve once the window is over and everyone has answered, or the grace period runs out. */
  private settleSnaps(room: Room) {
    const b = room.snaps;
    if (!b) return;
    const now = Date.now();
    const everyone = [...b.waitingFor].every((id) => b.done.has(id));
    if (now >= b.deadline && (everyone || now >= b.deadline + this.snapGraceMs)) return this.resolveSnaps(room);
    if (room.timer) clearTimeout(room.timer);
    const wake = now < b.deadline ? b.deadline : b.deadline + this.snapGraceMs;
    room.timer = setTimeout(() => {
      room.timer = null;
      this.settleSnaps(room);
    }, wake - now + 5);
  }

  /** Replay the window's snaps in the order they happened (not the order they arrived). */
  private resolveSnaps(room: Room) {
    const b = room.snaps!;
    room.snaps = null;
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    room.resolvingSnaps = true;
    try {
      for (const e of [...b.entries].sort((x, y) => x.at - y.at || x.order - y.order)) {
        // An earlier snap may already have closed the window (or ended the round): the rest were too slow.
        const ph = room.game?.state.phase;
        if (ph?.kind !== 'snap' || ph.windowId !== b.windowId) {
          this.out.log(`s:${e.playerId}`, { to: e.playerId, text: 'Too slow — someone snapped first' });
          continue;
        }
        try {
          this.apply(room, { type: 'SNAP', playerId: e.playerId, windowId: b.windowId, ownerId: e.ownerId, slot: e.slot, at: e.at });
        } catch (err) {
          if (!(err instanceof GameError)) throw err;
          if (this.bots.has(e.playerId) && !err.message.startsWith('Too slow')) this.botRejections.push(`SNAP: ${err.message}`);
          const text = !err.message.startsWith('Too slow')
            ? `Snap refused: ${err.message}`
            : e.at > b.deadline ? 'Too slow — the snap window had closed' : 'Too slow — someone snapped first';
          this.out.log(`s:${e.playerId}`, { to: e.playerId, text });
        }
      }
    } finally {
      room.resolvingSnaps = false;
    }
    const st = room.game?.state;
    // Nobody took the card: the window closes as usual.
    if (st?.phase.kind === 'snap' && st.phase.windowId === b.windowId) this.apply(room, { type: 'TICK' });
    else this.schedule(room);
  }

  setConnected(sessionId: string, connected: boolean) {
    const room = this.roomOf(sessionId);
    if (!room) return;
    if (connected) this.markOnline(room, sessionId);
    else this.markOffline(room, sessionId);
    this.broadcastRoom(room);
    // Don't hold a snap window for someone who just dropped.
    if (!connected && room.snaps?.waitingFor.delete(sessionId)) this.settleSnaps(room);
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
        if (p.bot) {
          // Bots are always "online"; their card memory starts fresh.
          this.bots.set(p.sessionId, newBot(p.sessionId, p.botLevel ?? 'intermediate'));
          this.markOnline(room, p.sessionId);
        } else this.markOffline(room, p.sessionId, now); // everyone starts offline; reconnecting clears it
      }
      this.schedule(room);
      this.scheduleBots(room);
    }
    return rows.length;
  }

  shutdown() {
    for (const room of this.rooms.values()) {
      if (room.timer) clearTimeout(room.timer);
      for (const t of room.kickTimers.values()) clearTimeout(t);
    }
    for (const bot of this.bots.values()) this.cancelBot(bot);
    for (const t of this.spectatorTimers.values()) clearTimeout(t);
  }
}

const newBot = (id: string, level: BotLevel): Bot => ({ brain: new BotBrain(id), level, timer: null, pending: null, version: -1 });
