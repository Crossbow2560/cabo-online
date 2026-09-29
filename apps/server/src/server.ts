import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import type { Action, BotLevel, ClientAction, ClientToServer, ServerToClient, Timings } from '@cabo/engine';
import { GameError, RoomManager } from './rooms';
import type { SessionRecord, Store } from './store';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const ACTION_TYPES = new Set([
  'READY', 'DRAW_STOCK', 'TAKE_DISCARD', 'CALL_CABO', 'KEEP', 'DISCARD_DRAWN',
  'PEEK_OWN', 'PEEK_OTHER', 'BLIND_SWAP', 'SWAP', 'SKIP', 'GIVE_CARD',
]);
const INT_FIELDS = ['slot', 'mySlot', 'expectedVersion'] as const;

/** Shape-checks client input; the engine does all rule validation. */
function parseAction(raw: unknown, playerId: string): Action {
  if (!raw || typeof raw !== 'object') throw new GameError('Bad action');
  const a = raw as Record<string, unknown>;
  if (typeof a.type !== 'string' || !ACTION_TYPES.has(a.type)) throw new GameError('Unknown action');
  const out: Record<string, unknown> = { type: a.type, playerId };
  for (const f of INT_FIELDS) {
    if (a[f] === undefined) continue;
    if (!Number.isInteger(a[f])) throw new GameError(`Bad ${f}`);
    out[f] = a[f];
  }
  if (a.targetId !== undefined) {
    if (typeof a.targetId !== 'string') throw new GameError('Bad targetId');
    out.targetId = a.targetId;
  }
  return out as unknown as Action;
}

export interface ServerOptions {
  store: Store;
  timings?: Partial<Timings>;
  /** Offline players are removed after this long (default 5 minutes). */
  kickAfterMs?: number;
  /** Dev/testing only: fixed deal seed. Never set in production. */
  fixedSeed?: number | null;
  /** How long the peek phase may wait for offline players (default 60s). */
  peekHoldMs?: number;
  /** Multiplies bot thinking delays (default 1; tests use a small value). */
  botPace?: number;
  /** How long past a snap window to wait for slow clients' snaps (default 1.5s). */
  snapGraceMs?: number;
  /** New rooms' points limit (default 100; null = none). */
  defaultMaxPoints?: number | null;
  /** R28: max snaps per socket per second. */
  snapRateLimit?: number;
  webDist?: string;
  /** Public address players use, e.g. https://cabo.nishit-db.com — used for invite links. */
  publicUrl?: string | null;
}

export async function createCaboServer(opts: ServerOptions) {
  const { store } = opts;
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  const http = createHttpServer(app);
  const io = new Server<ClientToServer, ServerToClient, {}, { session: SessionRecord; snaps: number[] }>(http, {
    cors: { origin: true },
  });

  const rooms = new RoomManager(
    store,
    {
      roomState: (code, state) => io.to(`r:${code}`).emit('room:state', state),
      view: (sid, view) => io.to(`s:${sid}`).emit('game:view', view),
      log: (target, event) => io.to(target).emit('game:log', { ...event, at: Date.now() }),
      detach: (sid, code) => {
        io.in(`s:${sid}`).socketsLeave(`r:${code}`);
        io.to(`s:${sid}`).emit('room:state', null);
      },
    },
    opts.timings,
    opts.kickAfterMs,
    opts.fixedSeed ?? null,
    opts.peekHoldMs,
    opts.botPace,
    opts.snapGraceMs,
    opts.defaultMaxPoints === undefined ? undefined : opts.defaultMaxPoints,
  );
  const restored = await rooms.restore();
  if (restored) console.log(`restored ${restored} room(s)`);

  // ---- HTTP: guest sessions ----
  app.post('/api/session', async (req, res) => {
    const nickname = String(req.body?.nickname ?? '').trim();
    if (nickname.length < 1 || nickname.length > 20) return res.status(400).json({ error: 'Nickname must be 1-20 characters' });
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    try {
      await store.createSession(id, hashToken(token), nickname);
    } catch (e) {
      console.error('[session]', e);
      return res.status(503).json({ error: 'Server busy, try again' });
    }
    res.json({ sessionId: id, nickname, token });
  });

  // Runtime config for the client (read at startup, so one build works on any domain).
  const publicUrl = opts.publicUrl?.replace(/\/+$/, '') || null;
  app.get('/api/config', (_req, res) => {
    res.json({ publicUrl });
  });

  app.get('/api/session', async (req, res) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    let s: SessionRecord | null;
    try {
      s = token ? await store.findSession(hashToken(token)) : null;
    } catch (e) {
      console.error('[session]', e);
      return res.status(503).json({ error: 'Server busy, try again' }); // client keeps its token and retries
    }
    if (!s) return res.status(401).json({ error: 'Unknown session' });
    const room = rooms.roomOf(s.id);
    const watching = rooms.spectatingOf(s.id);
    res.json({ sessionId: s.id, nickname: s.nickname, roomCode: room?.rec.code ?? watching?.rec.code ?? null });
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    app.use(express.static(opts.webDist));
    app.get('*', (_req, res) => res.sendFile(path.join(opts.webDist!, 'index.html')));
  }

  // ---- sockets ----
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    let session: SessionRecord | null;
    try {
      session = typeof token === 'string' ? await store.findSession(hashToken(token)) : null;
    } catch (e) {
      console.error('[auth]', e);
      return next(new Error('unavailable')); // transient (e.g. DB hiccup): client retries
    }
    if (!session) return next(new Error('unauthorized'));
    socket.data.session = session;
    socket.data.snaps = [];
    next();
  });

  io.on('connection', async (socket) => {
    const session = socket.data.session;
    const sid = session.id;

    // R27: one live socket per session — a new tab replaces the old one. Join first, so the old
    // socket's disconnect handler still sees this one and doesn't mark the player offline.
    const olds = await io.in(`s:${sid}`).fetchSockets();
    socket.join(`s:${sid}`);
    for (const old of olds) {
      old.emit('session:replaced');
      old.disconnect(true);
    }

    // Always tell a (re)connecting client where it stands, so it never shows a stale table.
    const existing = rooms.roomOf(sid);
    const watching = existing ? null : rooms.spectatingOf(sid);
    if (existing) {
      socket.join(`r:${existing.rec.code}`);
      rooms.setConnected(sid, true); // broadcasts room:state, including to this socket
      rooms.sendView(existing, sid);
    } else if (watching) {
      socket.join(`r:${watching.rec.code}`);
      rooms.spectatorOnline(sid, true);
      rooms.broadcastRoom(watching); // includes this socket
      rooms.sendView(watching, sid);
    } else {
      socket.emit('room:state', null);
      socket.emit('game:view', null);
    }

    // Wraps a handler: payload (if any) first, ack callback last; GameErrors become { ok: false }.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = (fn: (payload: any) => unknown) =>
      async (...args: unknown[]) => {
        const reply = (typeof args.at(-1) === 'function' ? args.pop() : () => {}) as (r: unknown) => void;
        try {
          const extra = (await fn(args[0])) as Record<string, unknown> | void;
          reply({ ok: true, ...(extra ?? {}) });
        } catch (e) {
          if (e instanceof GameError) reply({ ok: false, error: e.message });
          else {
            console.error(e);
            reply({ ok: false, error: 'Server error' });
          }
        }
      };

    socket.on('room:create', handle(async () => {
      const room = await rooms.create(session);
      socket.join(`r:${room.rec.code}`);
      rooms.broadcastRoom(room);
      return { code: room.rec.code };
    }) as never);

    socket.on('room:join', handle(async (req: { code: string }) => {
      const room = await rooms.join(session, req?.code);
      socket.join(`r:${room.rec.code}`);
      rooms.broadcastRoom(room);
      return { code: room.rec.code };
    }) as never);

    socket.on('room:spectate', handle((req: { code: string }) => {
      const room = rooms.spectate(session, req?.code);
      socket.join(`r:${room.rec.code}`);
      rooms.broadcastRoom(room);
      return { code: room.rec.code };
    }) as never);

    socket.on('room:leave', handle(async () => {
      const room = rooms.roomOf(sid) ?? rooms.spectatingOf(sid);
      await rooms.leave(sid);
      if (room) socket.leave(`r:${room.rec.code}`);
    }) as never);

    socket.on('room:start', handle(() => rooms.start(sid)) as never);
    socket.on('room:end', handle(() => rooms.end(sid)) as never);
    socket.on('room:settings', handle((req: Record<string, unknown>) => {
      if (!req || typeof req !== 'object') throw new GameError('Bad settings');
      return rooms.setSettings(sid, req as never);
    }) as never);
    socket.on('room:pause', handle(() => rooms.pause(sid)) as never);
    socket.on('room:resume', handle(() => rooms.resume(sid)) as never);

    socket.on('room:addBot', handle((req: { level?: unknown }) => {
      const level = req?.level ?? 'intermediate';
      if (typeof level !== 'string') throw new GameError('Unknown bot level');
      return rooms.addBot(sid, level as BotLevel);
    }) as never);

    socket.on('room:removeBot', handle((req: { id: string }) => {
      if (typeof req?.id !== 'string') throw new GameError('Bad bot');
      return rooms.removeBot(sid, req.id);
    }) as never);

    socket.on('game:action', handle((raw: ClientAction) => rooms.act(sid, parseAction(raw, sid))) as never);

    socket.on('game:snap', handle((req: { windowId: number; ownerId: string; slot: number; reactionMs?: number }) => {
      const now = Date.now();
      const limit = opts.snapRateLimit ?? 5;
      socket.data.snaps = socket.data.snaps.filter((t) => now - t < 1000);
      if (socket.data.snaps.length >= limit) throw new GameError('Slow down'); // R28
      socket.data.snaps.push(now);
      if (!req || !Number.isInteger(req.windowId) || !Number.isInteger(req.slot) || typeof req.ownerId !== 'string') {
        throw new GameError('Bad snap');
      }
      if (req.reactionMs !== undefined && typeof req.reactionMs !== 'number') throw new GameError('Bad snap');
      rooms.snap(sid, req);
    }) as never);

    socket.on('game:snapPass', handle((req: { windowId: number }) => {
      if (!req || !Number.isInteger(req.windowId)) throw new GameError('Bad pass');
      rooms.passSnap(sid, req.windowId);
    }) as never);

    socket.on('disconnect', async () => {
      const others = await io.in(`s:${sid}`).fetchSockets();
      if (others.length === 0) {
        rooms.setConnected(sid, false);
        rooms.spectatorOnline(sid, false);
      }
    });
  });

  return {
    app,
    http,
    io,
    rooms,
    async listen(port: number) {
      await new Promise<void>((r) => http.listen(port, r));
      const addr = http.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    },
    async close() {
      rooms.shutdown();
      io.close();
      await new Promise((r) => http.close(r));
    },
  };
}
