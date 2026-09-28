import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Ack, ClientToServer, GameEvent, PlayerView, RoomState, ServerToClient } from '@cabo/engine';
import { DesertBackdrop } from './components/DesertBackdrop';
import { RulesModal } from './components/RulesModal';
import { Game } from './Game';
import { captureMotion } from './lib/motion';
import { Landing } from './screens/Landing';
import { Nickname } from './screens/Nickname';
import { Lobby } from './screens/Lobby';
import { Rooms } from './screens/Rooms';

export type CaboSocket = Socket<ServerToClient, ClientToServer>;
/** `id` is a local sequence number; `rx` is when this client received it (for toasts). */
export type LogLine = GameEvent & { at: number; id: number; rx: number };

let logSeq = 0;

interface Session {
  sessionId: string;
  nickname: string;
  token: string;
}

const TOKEN_KEY = 'cabo.token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session lasts for this tab only */
  }
}

type Screen = 'landing' | 'nickname' | 'play';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>('landing');
  const [rulesOpen, setRulesOpen] = useState(false);

  useEffect(() => {
    const token = readToken();
    if (!token) return setLoading(false);
    let cancelled = false;
    let timer: number | undefined;
    // Only a 401 means the token is really gone. A 5xx / network error (e.g. the server restarting
    // during a deploy) must not wipe the player's identity: keep the token and retry.
    const check = (attempt: number) => {
      fetch('/api/session', { headers: { authorization: `Bearer ${token}` } })
        .then(async (r) => {
          if (cancelled) return;
          if (r.ok) {
            const s = await r.json();
            setSession({ sessionId: s.sessionId, nickname: s.nickname, token });
            if (s.roomCode) setScreen('play'); // already seated: straight back to the table
            setLoading(false);
          } else if (r.status === 401) {
            writeToken(null);
            setLoading(false);
          } else throw new Error(`HTTP ${r.status}`);
        })
        .catch(() => {
          if (!cancelled) timer = window.setTimeout(() => check(attempt + 1), Math.min(8000, 1000 * 2 ** attempt));
        });
    };
    check(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const signOut = () => {
    writeToken(null);
    setSession(null);
    setScreen('nickname');
  };

  let content: React.ReactNode;
  if (loading) content = <main className="screen"><p className="tagline">Saddling up…</p></main>;
  else if (screen === 'landing' || (screen === 'play' && !session)) {
    content = <Landing onPlay={() => setScreen(session ? 'play' : 'nickname')} onRules={() => setRulesOpen(true)} />;
  } else if (screen === 'nickname' || !session) {
    content = (
      <Nickname
        onBack={() => setScreen('landing')}
        onSession={(s) => {
          writeToken(s.token);
          setSession(s);
          setScreen('play');
        }}
      />
    );
  } else content = <Connected session={session} onSignOut={signOut} onRules={() => setRulesOpen(true)} />;

  return (
    <>
      <DesertBackdrop />
      {content}
      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </>
  );
}

function Connected({ session, onSignOut, onRules }: { session: Session; onSignOut: () => void; onRules: () => void }) {
  const [socket, setSocket] = useState<CaboSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState('');
  const [replaced, setReplaced] = useState(false);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    const s: CaboSocket = io({ auth: { token: session.token } });
    s.on('connect', () => {
      setSynced(false); // wait for the server to say which room (if any) we're in
      setConnected(true);
    });
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', (e) => {
      if (e.message === 'unauthorized') return onSignOut();
      // Server-side rejections don't auto-reconnect; anything but "unauthorized" is transient.
      if (!s.active) window.setTimeout(() => s.connect(), 2000);
    });
    s.on('room:state', (r) => {
      setRoom(r);
      if (!r) setView(null);
      setSynced(true);
    });
    s.on('game:view', setView);
    s.on('game:log', (line) => {
      if (line.motion) captureMotion(line.motion); // measure where cards start before the view updates
      setLog((l) => [...l.slice(-199), { ...line, id: ++logSeq, rx: Date.now() }]);
    });
    s.on('session:replaced', () => {
      setReplaced(true);
      s.disconnect();
    });
    setSocket(s);
    return () => {
      s.disconnect();
    };
  }, [session.token]);

  // Pre-fill / auto-join from ?room=CODE
  const urlCode = new URLSearchParams(location.search).get('room') ?? '';

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(''), 4000);
    return () => clearTimeout(t);
  }, [error]);

  if (replaced) {
    return (
      <main className="screen">
        <div className="panel stack">
          <h2 className="heading">Opened elsewhere</h2>
          <p>This session is active in another tab.</p>
          <button className="btn btn--primary" onClick={() => location.reload()}>Use it here</button>
        </div>
      </main>
    );
  }
  if (!socket || !connected || !synced) {
    return (
      <main className="screen">
        <p className="tagline">Saddling up…</p>
      </main>
    );
  }

  const call = <T,>(fn: (ack: (r: Ack<T>) => void) => void) =>
    new Promise<Ack<T>>((res) => fn(res)).then((r) => {
      setError(r.ok ? '' : r.error);
      return r;
    });

  const inRoom = room && room.players.some((p) => p.id === session.sessionId);
  const leave = () =>
    call((ack) => socket.emit('room:leave', ack)).then((r) => {
      if (r.ok) {
        setRoom(null);
        setView(null);
        setLog([]);
      }
    });

  return (
    <>
      {error && <div className="banner" role="alert">{error}</div>}
      {!inRoom ? (
        <Rooms
          nickname={session.nickname}
          initialCode={urlCode}
          onCreate={() => call<{ code: string }>((ack) => socket.emit('room:create', ack))}
          onJoin={(code) => call<{ code: string }>((ack) => socket.emit('room:join', { code }, ack))}
          onChangeName={onSignOut}
        />
      ) : room.status === 'lobby' ? (
        <Lobby
          room={room}
          me={session.sessionId}
          onStart={() => call((ack) => socket.emit('room:start', ack))}
          onLeave={leave}
        />
      ) : view ? (
        <Game
          view={view}
          room={room}
          socket={socket}
          log={log}
          call={call}
          onStart={() => call((ack) => socket.emit('room:start', ack))}
          onLeave={leave}
          onRules={onRules}
        />
      ) : (
        <main className="screen">
          <p className="tagline">Dealing the cards…</p>
        </main>
      )}
    </>
  );
}
