import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import type { Action, ClientAction, ClientToServer, ServerToClient, Timings } from '@cabo/engine';
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
    },
    opts.timings,
    opts.kickAfterMs,
  );
  const restored = await rooms.restore();
  if (restored) console.log(`restored ${restored} room(s)`);

  // ---- HTTP: guest sessions ----
  app.post('/api/session', async (req, res) => {
    const nickname = String(req.body?.nickname ?? '').trim();
    if (nickname.length < 1 || nickname.length > 20) return res.status(400).json({ error: 'Nickname must be 1-20 characters' });
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    await store.createSession(id, hashToken(token), nickname);
    res.json({ sessionId: id, nickname, token });
  });

  // Runtime config for the client (read at startup, so one build works on any domain).
  const publicUrl = opts.publicUrl?.replace(/\/+$/, '') || null;
  app.get('/api/config', (_req, res) => {
    res.json({ publicUrl });
  });

  app.get('/api/session', async (req, res) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const s = token ? await store.findSession(hashToken(token)) : null;
    if (!s) return res.status(401).json({ error: 'Unknown session' });
    const room = rooms.roomOf(s.id);
    res.json({ sessionId: s.id, nickname: s.nickname, roomCode: room?.rec.code ?? null });
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    app.use(express.static(opts.webDist));
    app.get('*', (_req, res) => res.sendFile(path.join(opts.webDist!, 'index.html')));
  }

  // ---- sockets ----
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const session = typeof token === 'string' ? await store.findSession(hashToken(token)) : null;
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

    const existing = rooms.roomOf(sid);
    if (existing) {
      socket.join(`r:${existing.rec.code}`);
      rooms.setConnected(sid, true);
      rooms.sendView(existing, sid);
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

    socket.on('room:leave', handle(async () => {
      const room = rooms.roomOf(sid);
      await rooms.leave(sid);
      if (room) socket.leave(`r:${room.rec.code}`);
    }) as never);

    socket.on('room:start', handle(() => rooms.start(sid)) as never);

    socket.on('game:action', handle((raw: ClientAction) => rooms.act(sid, parseAction(raw, sid))) as never);

    socket.on('game:snap', handle((req: { windowId: number; ownerId: string; slot: number }) => {
      const now = Date.now();
      const limit = opts.snapRateLimit ?? 5;
      socket.data.snaps = socket.data.snaps.filter((t) => now - t < 1000);
      if (socket.data.snaps.length >= limit) throw new GameError('Slow down'); // R28
      socket.data.snaps.push(now);
      if (!req || !Number.isInteger(req.windowId) || !Number.isInteger(req.slot) || typeof req.ownerId !== 'string') {
        throw new GameError('Bad snap');
      }
      rooms.act(sid, { type: 'SNAP', playerId: sid, windowId: req.windowId, ownerId: req.ownerId, slot: req.slot });
    }) as never);

    socket.on('disconnect', async () => {
      const others = await io.in(`s:${sid}`).fetchSockets();
      if (others.length === 0) rooms.setConnected(sid, false);
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
