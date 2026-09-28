import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { cardValue, type PlayerView } from '@cabo/engine';
import { createCaboServer } from '../src/server';
import { MemoryStore, PgStore, type Store } from '../src/store';

const TIMINGS = { peekMs: 5_000, turnMs: 5_000, choiceMs: 5_000, snapMs: 150 };

type Server = Awaited<ReturnType<typeof createCaboServer>>;
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  for (const s of servers.splice(0)) await s.close();
});

async function start(store: Store = new MemoryStore(), kickAfterMs?: number) {
  const server = await createCaboServer({ store, timings: TIMINGS, kickAfterMs });
  const port = await server.listen(0);
  servers.push(server);
  return { server, port, url: `http://localhost:${port}` };
}

interface Bot {
  id: string;
  token: string;
  socket: Socket;
  view: PlayerView | null;
  logs: string[];
  emit<T = { ok: boolean; error?: string; code?: string }>(ev: string, payload?: unknown): Promise<T>;
  until(pred: (v: PlayerView) => boolean, ms?: number): Promise<PlayerView>;
}

async function bot(url: string, name: string, existingToken?: { id: string; token: string }): Promise<Bot> {
  const sess = existingToken ?? (await (await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: name }),
  })).json() as { sessionId: string; token: string } & { id?: string });
  const id = 'sessionId' in sess ? (sess as { sessionId: string }).sessionId : sess.id;
  const socket = connect(url, { auth: { token: sess.token }, transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  const b: Bot = {
    id,
    token: sess.token,
    socket,
    view: null,
    logs: [],
    emit: (ev, payload) =>
      new Promise((res) => (payload === undefined ? socket.emit(ev, res) : socket.emit(ev, payload, res))),
    until: (pred, ms = 3000) =>
      new Promise((res, rej) => {
        if (b.view && pred(b.view)) return res(b.view);
        const t = setTimeout(() => rej(new Error(`timeout waiting for view (${b.view?.phase})`)), ms);
        const on = (v: PlayerView | null) => {
          if (v && pred(v)) {
            clearTimeout(t);
            socket.off('game:view', on);
            res(v);
          }
        };
        socket.on('game:view', on);
      }),
  };
  socket.on('game:view', (v) => (b.view = v));
  socket.on('game:log', (e) => b.logs.push(e.text));
  await new Promise<void>((res, rej) => {
    socket.on('connect', () => res());
    socket.on('connect_error', rej);
  });
  return b;
}

async function lobby(url: string, n = 3) {
  const bots = [await bot(url, 'Ana')];
  const created = await bots[0].emit('room:create');
  expect(created.ok).toBe(true);
  for (let i = 1; i < n; i++) {
    const b = await bot(url, `Bot${i}`);
    expect((await b.emit('room:join', { code: created.code })).ok).toBe(true);
    bots.push(b);
  }
  return { bots, code: created.code! };
}

async function startAndReady(bots: Bot[]) {
  expect((await bots[0].emit('room:start')).ok).toBe(true);
  await Promise.all(bots.map((b) => b.until((v) => v.phase === 'peek')));
  for (const b of bots) expect((await b.emit('game:action', { type: 'READY' })).ok).toBe(true);
  return bots[0].until((v) => v.phase === 'choose');
}

describe('server', () => {
  it('/api/config reports PUBLIC_URL (trailing slash trimmed), or null when unset', async () => {
    const plain = await start();
    expect(await (await fetch(`${plain.url}/api/config`)).json()).toEqual({ publicUrl: null });
    const server = await createCaboServer({ store: new MemoryStore(), publicUrl: 'https://cabo.nishit-db.com/' });
    servers.push(server);
    const port = await server.listen(0);
    expect(await (await fetch(`http://localhost:${port}/api/config`)).json()).toEqual({ publicUrl: 'https://cabo.nishit-db.com' });
  });

  it('rejects sockets without a valid session', async () => {
    const { url } = await start();
    const s = connect(url, { auth: { token: 'nope' }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    const err = await new Promise<Error>((res) => s.on('connect_error', res));
    expect(err.message).toBe('unauthorized');
  });

  it('3 bots play a full round ending in cabo; scores match revealed cards', async () => {
    const { url } = await start();
    const { bots } = await lobby(url);
    const byId = (id: string) => bots.find((b) => b.id === id)!;

    let v = await startAndReady(bots);
    // Nobody sees any card after ready.
    for (const b of bots) expect(b.view!.players.flatMap((p) => p.slots).every((s) => s?.card == null)).toBe(true);

    const caller = byId(v.currentPlayerId);
    expect((await caller.emit('game:action', { type: 'CALL_CABO', expectedVersion: v.version })).ok).toBe(true);

    for (let turn = 0; turn < 2; turn++) {
      v = await caller.until((x) => x.phase === 'choose');
      const cur = byId(v.currentPlayerId);
      expect(cur).not.toBe(caller);
      expect((await cur.emit('game:action', { type: 'DRAW_STOCK' })).ok).toBe(true);
      const drawn = await cur.until((x) => x.phase === 'drawn');
      expect(drawn.drawnCard).not.toBeNull();
      for (const other of bots.filter((b) => b !== cur)) expect(other.view!.drawnCard).toBeNull();
      expect((await cur.emit('game:action', { type: 'DISCARD_DRAWN' })).ok).toBe(true);
      const after = await cur.until((x) => x.phase !== 'drawn');
      if (after.phase === 'ability') expect((await cur.emit('game:action', { type: 'SKIP' })).ok).toBe(true);
      await cur.until((x) => x.currentPlayerId !== cur.id || x.phase === 'ended');
    }

    const end = await bots[0].until((x) => x.phase === 'ended');
    for (const p of end.players) {
      const sum = p.slots.reduce((n, s) => n + (s?.card ? cardValue(s.card) : 0), 0);
      expect(end.result!.scores[p.id]).toBe(sum);
    }
  });

  it('simultaneous correct snaps: exactly one wins, the other is too slow without penalty', async () => {
    const { url, server } = await start();
    const { bots, code } = await lobby(url);
    const v = await startAndReady(bots);
    const cur = bots.find((b) => b.id === v.currentPlayerId)!;
    await cur.emit('game:action', { type: 'DRAW_STOCK' });
    await cur.emit('game:action', { type: 'KEEP', slot: 0 });
    const w = await cur.until((x) => x.phase === 'snap');

    // Rig two opponents' slot 0 to match the discard top.
    const state = server.rooms.rooms.get(code)!.game!.state;
    const [a, b] = bots.filter((x) => x !== cur);
    const top = state.discard.at(-1)!;
    for (const who of [a, b]) state.players.find((p) => p.id === who.id)!.slots[0] = { ...top };

    const [ra, rb] = await Promise.all([
      a.emit('game:snap', { windowId: w.snapWindowId, ownerId: a.id, slot: 0 }),
      b.emit('game:snap', { windowId: w.snapWindowId, ownerId: b.id, slot: 0 }),
    ]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    const loser = ra.ok ? rb : ra;
    expect(loser.error).toMatch(/too slow/i);
    const finalState = server.rooms.rooms.get(code)!.game!.state;
    expect(finalState.players.map((p) => p.slots.length)).toEqual([4, 4, 4]);
  });

  it('rejects joining a round in progress and malformed actions', async () => {
    const { url } = await start();
    const { bots, code } = await lobby(url, 2);
    await startAndReady(bots);
    const late = await bot(url, 'Late');
    expect(await late.emit('room:join', { code })).toMatchObject({ ok: false, error: 'A round is in progress' });
    expect(await bots[0].emit('game:action', { type: 'TICK' })).toMatchObject({ ok: false });
    expect(await bots[0].emit('game:action', { type: 'KEEP', slot: 'x' })).toMatchObject({ ok: false });
  });

  describe('auto-kick after being offline', () => {
    const KICK = 300;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('lobby: an offline player is removed and host passes on', async () => {
      const { url, server } = await start(new MemoryStore(), KICK);
      const { bots, code } = await lobby(url, 2);
      const states: { hostId: string; players: { id: string; offlineSince: number | null }[] }[] = [];
      bots[1].socket.on('room:state', (r) => states.push(r));
      bots[0].socket.disconnect();
      await sleep(100);
      const away = states.at(-1)!.players.find((p) => p.id === bots[0].id)!;
      expect(away.offlineSince).toBeTypeOf('number');
      await sleep(KICK + 100);
      const room = server.rooms.rooms.get(code)!;
      expect(room.rec.players.map((p) => p.sessionId)).toEqual([bots[1].id]);
      expect(room.rec.hostId).toBe(bots[1].id);
      expect(states.at(-1)!.hostId).toBe(bots[1].id);
    });

    it('reconnecting before the deadline cancels the kick', async () => {
      const { url, server } = await start(new MemoryStore(), KICK);
      const { bots, code } = await lobby(url, 2);
      bots[1].socket.disconnect();
      await sleep(KICK / 2);
      await bot(url, '', { id: bots[1].id, token: bots[1].token });
      await sleep(KICK + 100);
      expect(server.rooms.rooms.get(code)!.rec.players).toHaveLength(2);
    });

    it('mid-round: dropping below 2 players ends the round, last one standing wins', async () => {
      const { url, server } = await start(new MemoryStore(), KICK);
      const { bots, code } = await lobby(url, 2);
      await startAndReady(bots);
      const [stayer, leaver] = bots;
      const kickedView = new Promise((res) => leaver.socket.on('game:view', (v) => v === null && res(v)));
      leaver.socket.disconnect();
      const end = await stayer.until((v) => v.phase === 'ended', KICK + 1000);
      expect(end.result).toMatchObject({ reason: 'forfeit', winners: [stayer.id] });
      expect(end.players.map((p) => p.id)).toEqual([stayer.id]);
      const room = server.rooms.rooms.get(code)!;
      expect(room.rec.status).toBe('finished');
      expect(room.rec.players.map((p) => p.sessionId)).toEqual([stayer.id]);
      expect(stayer.logs.some((l) => /last one standing/i.test(l))).toBe(true);
      void kickedView;
    });

    it('mid-round with 3 players: the kicked player is dropped and play continues', async () => {
      const { url } = await start(new MemoryStore(), KICK);
      const { bots } = await lobby(url, 3);
      await startAndReady(bots);
      bots[2].socket.disconnect();
      const v = await bots[0].until((x) => x.players.length === 2, KICK + 1000);
      expect(v.phase).not.toBe('ended');
      expect(v.players.map((p) => p.id)).toEqual([bots[0].id, bots[1].id]);
    });

    it('leaving mid-round forfeits: with 2 players the other one wins', async () => {
      const { url, server } = await start();
      const { bots, code } = await lobby(url, 2);
      await startAndReady(bots);
      expect(await bots[1].emit('room:leave')).toMatchObject({ ok: true });
      const end = await bots[0].until((v) => v.phase === 'ended');
      expect(end.result).toMatchObject({ reason: 'forfeit', winners: [bots[0].id] });
      expect(server.rooms.roomOf(bots[1].id)).toBeNull();
      expect(bots[0].logs.some((l) => l.includes('left the game'))).toBe(true);
      expect(server.rooms.rooms.get(code)!.rec.players).toHaveLength(1);
    });
  });

  it('second socket for the same session replaces the first', async () => {
    const { url } = await start();
    const a = await bot(url, 'Ana');
    const replaced = new Promise((res) => a.socket.on('session:replaced', res));
    await bot(url, 'Ana', { id: a.id, token: a.token });
    await replaced;
  });

  const pgUrl = process.env.TEST_DATABASE_URL;
  const stores: [string, () => Store][] = [['memory', () => new MemoryStore()]];
  if (pgUrl) stores.push(['postgres', () => new PgStore(pgUrl)]);

  it.each(stores)('restores a round in progress after a restart (%s store)', async (_name, makeStore) => {
    const store = makeStore();
    const first = await start(store);
    const { bots, code } = await lobby(first.url);
    const v = await startAndReady(bots);
    await new Promise((r) => setTimeout(r, 300)); // let snapshot writes land
    sockets.splice(0).forEach((s) => s.disconnect());
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);

    const second = await start(store);
    const again = await bot(second.url, '', { id: bots[1].id, token: bots[1].token });
    const restored = await again.until(() => true);
    expect(restored.version).toBe(v.version);
    expect(restored.currentPlayerId).toBe(v.currentPlayerId);
    expect(second.server.rooms.rooms.get(code)?.rec.players).toHaveLength(3);
    await store.close();
  });
});
