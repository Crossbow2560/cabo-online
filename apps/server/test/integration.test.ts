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

async function start(store: Store = new MemoryStore(), kickAfterMs?: number, extra: { timings?: object; peekHoldMs?: number; botPace?: number } = {}) {
  const server = await createCaboServer({
    store,
    timings: { ...TIMINGS, ...extra.timings },
    kickAfterMs,
    peekHoldMs: extra.peekHoldMs,
    botPace: extra.botPace ?? 0.005,
  });
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

  it('a store outage is a retryable 503 / "unavailable", never a 401 that would wipe the token', async () => {
    class FlakyStore extends MemoryStore {
      down = false;
      override async findSession(h: string) {
        if (this.down) throw new Error('db down');
        return super.findSession(h);
      }
    }
    const store = new FlakyStore();
    const { url } = await start(store);
    const sess = (await (await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: 'Ana' }),
    })).json()) as { token: string };
    store.down = true;
    const r = await fetch(`${url}/api/session`, { headers: { authorization: `Bearer ${sess.token}` } });
    expect(r.status).toBe(503);
    const sock = connect(url, { auth: { token: sess.token }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(sock);
    expect((await new Promise<Error>((res) => sock.on('connect_error', res))).message).toBe('unavailable');
    store.down = false;
    expect((await fetch(`${url}/api/session`, { headers: { authorization: `Bearer ${sess.token}` } })).status).toBe(200);
  });

  it('the peek phase waits for a player who is offline (e.g. reconnecting) before play starts', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { url, server } = await start(new MemoryStore(), 60_000, { timings: { peekMs: 200 }, peekHoldMs: 3_000 });
    const { bots, code } = await lobby(url, 2);
    expect((await bots[0].emit('room:start')).ok).toBe(true);
    await bots[0].until((v) => v.phase === 'peek');
    bots[1].socket.disconnect();
    await sleep(900); // well past the 200ms peek timer
    expect(server.rooms.rooms.get(code)!.game!.state.phase.kind).toBe('peek');
    const back = await bot(url, '', { id: bots[1].id, token: bots[1].token });
    const v = await back.until((x) => x.phase === 'peek');
    expect(v.players.find((p) => p.id === bots[1].id)!.slots.filter((s) => s?.card).length).toBe(2); // sees their 2 cards
    await back.until((x) => x.phase === 'choose', 8_000); // then play starts normally
  }, 15_000);

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

    it('a second tab replacing the first does not mark the player offline', async () => {
      const { url, server } = await start(new MemoryStore(), KICK);
      const { bots, code } = await lobby(url, 2);
      await bot(url, '', { id: bots[1].id, token: bots[1].token }); // replaces bots[1]'s socket
      await sleep(KICK + 150);
      const room = server.rooms.rooms.get(code)!;
      expect(room.rec.players).toHaveLength(2);
      expect(room.connected.has(bots[1].id)).toBe(true);
      expect(room.offlineSince.has(bots[1].id)).toBe(false);
    });

    it('a kicked player who reconnects is told they are in no room (no stale table)', async () => {
      const { url } = await start(new MemoryStore(), KICK);
      const { bots } = await lobby(url, 3);
      await startAndReady(bots);
      bots[2].socket.disconnect();
      await bots[0].until((v) => v.players.length === 2, KICK + 1000);
      const again = connect(url, { auth: { token: bots[2].token }, transports: ['websocket'], forceNew: true });
      sockets.push(again);
      const [state, view] = await Promise.all([
        new Promise((res) => again.once('room:state', res)),
        new Promise((res) => again.once('game:view', res)),
      ]);
      expect(state).toBeNull();
      expect(view).toBeNull();
    });

    it('after leaving, a player stops receiving that room\'s updates', async () => {
      const { url } = await start();
      const { bots } = await lobby(url, 3);
      const seen: unknown[] = [];
      bots[2].socket.on('room:state', (r) => seen.push(r));
      expect((await bots[2].emit('room:leave')).ok).toBe(true);
      await sleep(100);
      expect(seen.at(-1)).toBeNull();
      const before = seen.length;
      await bots[1].emit('room:leave'); // another room change
      await sleep(150);
      expect(seen.length).toBe(before);
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

describe('server-side bots', () => {
  const roomOf = (b: Bot) =>
    new Promise<import('@cabo/engine').RoomState>((res) => {
      b.socket.once('room:state', (r) => res(r));
    });

  it('only the host can add or remove bots, and only between rounds', async () => {
    const { url } = await start();
    const { bots: [host, guest] } = await lobby(url, 2);
    expect(await guest.emit('room:addBot')).toMatchObject({ ok: false, error: 'Only the host can manage bots' });
    const next = roomOf(host);
    expect((await host.emit('room:addBot')).ok).toBe(true);
    const room = await next;
    const bot = room.players.find((p) => p.bot)!;
    expect(bot).toMatchObject({ name: 'Dusty (bot)', connected: true });
    expect(await guest.emit('room:removeBot', { id: bot.id })).toMatchObject({ ok: false });
    expect(await host.emit('room:removeBot', { id: guest.id })).toMatchObject({ ok: false, error: 'No such bot' });

    await startAndReady([host, guest].slice(0, 1).concat(guest));
    expect(await host.emit('room:addBot')).toMatchObject({ ok: false, error: 'Wait for the round to end' });
    expect(await host.emit('room:removeBot', { id: bot.id })).toMatchObject({ ok: false, error: 'Wait for the round to end' });
  });

  it('removing a bot frees its seat', async () => {
    const { url } = await start();
    const { bots: [host] } = await lobby(url, 1);
    await host.emit('room:addBot');
    await host.emit('room:addBot');
    const next = roomOf(host);
    const ids = (await new Promise<string[]>((res) => {
      host.socket.once('room:state', (r) => res(r.players.filter((p: { bot: boolean }) => p.bot).map((p: { id: string }) => p.id)));
      void host.emit('room:addBot');
    }));
    await next;
    expect(ids).toHaveLength(3);
    const after = roomOf(host);
    expect((await host.emit('room:removeBot', { id: ids[1] })).ok).toBe(true);
    expect((await after).players.map((p) => p.name)).toEqual(['Ana', 'Dusty (bot)', 'Doc (bot)']);
  });

  it('a human and bots play whole rounds; bots only ever act legally', async () => {
    const { url, server } = await start();
    const { bots: [human] } = await lobby(url, 1);
    for (let i = 0; i < 3; i++) expect((await human.emit('room:addBot')).ok).toBe(true);

    for (let round = 1; round <= 2; round++) {
      expect((await human.emit('room:start')).ok).toBe(true);
      await human.until((v) => v.phase === 'peek' && v.version === 0);
      await human.emit('game:action', { type: 'READY' });
      // The human plays the plainest game: draw, discard, skip abilities.
      const onView = (v: PlayerView | null) => {
        if (!v || v.currentPlayerId !== human.id) return;
        const move =
          v.phase === 'choose' ? { type: 'DRAW_STOCK' } :
          v.phase === 'drawn' ? { type: 'DISCARD_DRAWN' } :
          v.phase === 'ability' ? { type: 'SKIP' } : null;
        if (move) void human.emit('game:action', { ...move, expectedVersion: v.version });
      };
      human.socket.on('game:view', onView);
      const end = await human.until((v) => v.phase === 'ended', 20_000);
      human.socket.off('game:view', onView);
      expect(end.result!.winners.length).toBeGreaterThan(0);
      // Bots' moves went through the engine like anyone's; the table stays whole.
      const st = server.rooms.roomOf(human.id)!.game!.state;
      const cards = st.players.reduce((n, p) => n + p.slots.filter(Boolean).length, 0) + st.stock.length + st.discard.length;
      expect(cards).toBe(54);
    }
    expect(server.rooms.botRejections).toEqual([]);
    expect(human.logs.some((l) => /^(Dusty|Calamity|Doc) \(bot\) (drew|took|called)/.test(l))).toBe(true);
  }, 60_000);

  it('the room closes when the last human leaves; a bot never becomes host', async () => {
    const { url, server } = await start();
    const { bots: [host, guest], code } = await lobby(url, 2);
    await host.emit('room:addBot');
    expect((await host.emit('room:leave')).ok).toBe(true);
    expect(server.rooms.rooms.get(code)!.rec.hostId).toBe(guest.id);
    expect((await guest.emit('room:leave')).ok).toBe(true);
    expect(server.rooms.rooms.has(code)).toBe(false);
  });
});
