import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cardLabel, type Ack, type Card, type ClientAction, type PlayerView, type RoomState } from '@cabo/engine';
import type { CaboSocket, LogLine } from './App';
import { ActionBar, type Pick } from './components/ActionBar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { LogDock, Toasts } from './components/EventFeed';
import { Hand, type SlotState } from './components/Hand';
import { PlayersCard } from './components/PlayersCard';
import { PlayingCard } from './components/PlayingCard';
import { RoundResults } from './components/RoundResults';
import { Seat } from './components/Seat';
import { SoundControl } from './components/SoundControl';
import { Icon } from './components/Icon';
import { playSound, useMusic } from './lib/sound';
import { Title } from './components/Title';
import { playDeal, playMotions } from './lib/motion';
import { useMediaQuery } from './lib/useMediaQuery';
import { useNow } from './lib/useNow';
import type { Orient } from './components/PlayingCard';

type Call = <T>(fn: (ack: (r: Ack<T>) => void) => void) => Promise<Ack<T>>;


const ABILITY_BADGE: Record<string, string> = {
  peek_own: '✦ Peek at yours',
  peek_other: '✦ Spy',
  blind_swap: '⇄ Blind swap',
  look_swap: '✦ Look & swap',
};

const ABILITY_TEXT: Record<string, string> = {
  peek_own: 'Peek at one of your own cards',
  peek_other: "Peek at another player's card",
  blind_swap: "Blind swap: tap one of your cards, then someone else's",
  look_swap: "Black King: tap another player's card to look at it",
};

export function Game({ view, room, socket, log, call, onStart, onLeave, onRules }: {
  view: PlayerView;
  room: RoomState;
  socket: CaboSocket;
  log: LogLine[];
  call: Call;
  onStart: () => void;
  onLeave: () => void;
  onRules: () => void;
}) {
  const [pick, setPick] = useState<Pick>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, { card: Card; until: number }>>({});
  const seenLog = useRef(log.at(-1)?.id ?? 0);
  const now = useNow(200);
  const me = view.you;
  // Watching without a seat: everyone sits around the table, nothing is tappable.
  const spectator = !view.players.some((p) => p.id === me);
  const myTurn = view.currentPlayerId === me;
  const name = (id: string) => view.players.find((p) => p.id === id)?.name ?? 'a player who left';

  useEffect(() => setPick(null), [view.phase, view.currentPlayerId, view.abilityPeeked, view.abilityPeekedMine]);

  // Card animations: play queued moves once the new state is on screen; deal at round start.
  const dealtRound = useRef<number | null>(null);
  useLayoutEffect(() => {
    // Animations are decoration: a glitch in them must never take the table down.
    try {
      if (view.phase === 'peek' && view.version === 0 && dealtRound.current !== room.roundNo) {
        dealtRound.current = room.roundNo;
        const d = view.players.findIndex((p) => p.id === view.dealerId);
        const order = view.players.map((_, i) => view.players[(d + 1 + i) % view.players.length].id);
        playDeal(order, Math.max(...view.players.map((p) => p.slots.length)));
        return;
      }
      playMotions(me);
    } catch (e) {
      console.error('[motion]', e);
    }
  }, [view.version, view.phase, room.roundNo]);

  // Private peek results: kept so a Black King "look" stays visible while its owner decides to swap.
  // (The peek itself is animated in lib/motion.ts.)
  useEffect(() => {
    const fresh = log.filter((l) => l.id > seenLog.current);
    if (!fresh.length) return;
    seenLog.current = fresh.at(-1)!.id;
    const add: Record<string, { card: Card; until: number }> = {};
    for (const l of fresh) if (l.reveal && l.to === me) add[`${l.reveal.playerId}:${l.reveal.slot}`] = { card: l.reveal.card, until: Date.now() };
    if (Object.keys(add).length) setRevealed((r) => ({ ...r, ...add }));
  }, [log, me]);

  const act = (action: ClientAction) =>
    call((ack) => socket.emit('game:action', { ...action, expectedVersion: view.version } as ClientAction, ack)).then(() => setPick(null));

  // Snap windows are timed from when *this* screen shows them, and the server orders snaps by the
  // reported reaction time, so a slow connection doesn't lose the race (see RoomManager.snap).
  const snapWin = useRef<{ id: number | null; seenAt: number; seenAtWall: number }>({ id: null, seenAt: 0, seenAtWall: 0 });
  if (view.snapWindowId !== snapWin.current.id) {
    snapWin.current = { id: view.snapWindowId, seenAt: performance.now(), seenAtWall: Date.now() };
  }
  const sentSnap = useRef<number | null>(null);
  const [snapStatus, setSnapStatus] = useState<{ id: number; status: 'sent' | 'over' } | null>(null);
  const mySnap = snapStatus && snapStatus.id === view.snapWindowId ? snapStatus.status : null;
  useEffect(() => {
    const id = view.snapWindowId;
    if (id === null || spectator || view.snapOnlyFor) return; // a streak isn't raced: no pass needed
    const left = view.snapMs - (performance.now() - snapWin.current.seenAt);
    const t = window.setTimeout(() => {
      setSnapStatus((s) => (s?.id === id ? s : { id, status: 'over' }));
      // Tell the server we're done so it needn't wait for us.
      if (sentSnap.current !== id) socket.emit('game:snapPass', { windowId: id }, () => {});
    }, Math.max(0, left));
    return () => window.clearTimeout(t);
  }, [view.snapWindowId]);

  const snap = (ownerId: string, slot: number) => {
    const id = view.snapWindowId!;
    if (mySnap) return; // one snap per window
    sentSnap.current = id;
    setSnapStatus({ id, status: 'sent' });
    const reactionMs = Math.round(performance.now() - snapWin.current.seenAt);
    return call((ack) => socket.emit('game:snap', { windowId: id, ownerId, slot, reactionMs }, ack));
  };

  /** Which cards are a valid tap right now — mirrors onCard. */
  const canTap = (ownerId: string, slot: number): boolean => {
    const s = view.players.find((p) => p.id === ownerId)?.slots[slot];
    if (!s || spectator) return false;
    const mine = ownerId === me;
    // R30: in a snap streak only the first snapper may snap, and only their own cards.
    // R29: nobody else can snap the CABO caller's cards.
    if (view.phase === 'snap') {
      if (view.snapOnlyFor) return view.snapOnlyFor === me && mine && mySnap === null;
      return mySnap === null && (mine || ownerId !== view.caboCalledBy);
    }
    if (view.phase === 'give') return view.give?.snapperId === me && mine;
    if (!myTurn) return false;
    if (view.phase === 'choose') return pick === 'take_discard' && mine;
    if (view.phase === 'drawn') return mine;
    if (view.phase === 'ability') {
      switch (view.ability) {
        case 'peek_own': return mine;
        case 'peek_other': return !mine;
        // R10: theirs first, then one of yours; then Swap / Keep buttons (no more taps).
        case 'look_swap': return !view.abilityPeeked ? !mine : view.abilityPeekedMine === null && mine;
        // R29: the CABO caller's cards can't be swapped with.
        case 'blind_swap': return mine || (pick !== null && typeof pick === 'object' && ownerId !== view.caboCalledBy);
      }
    }
    return false;
  };

  const onCard = (ownerId: string, slot: number) => {
    const mine = ownerId === me;
    if (view.phase === 'snap') return snap(ownerId, slot);
    if (view.phase === 'give' && view.give?.snapperId === me && mine) return act({ type: 'GIVE_CARD', mySlot: slot });
    if (!myTurn) return;
    if (view.phase === 'choose' && pick === 'take_discard' && mine) return act({ type: 'TAKE_DISCARD', slot });
    if (view.phase === 'drawn' && mine) return act({ type: 'KEEP', slot });
    if (view.phase === 'ability') {
      switch (view.ability) {
        case 'peek_own':
          if (mine) act({ type: 'PEEK_OWN', slot });
          return;
        case 'peek_other':
          if (!mine) act({ type: 'PEEK_OTHER', targetId: ownerId, slot });
          return;
        case 'look_swap':
          if (!view.abilityPeeked && !mine) act({ type: 'PEEK_OTHER', targetId: ownerId, slot });
          else if (view.abilityPeeked && view.abilityPeekedMine === null && mine) act({ type: 'PEEK_OWN', slot });
          return;
        case 'blind_swap':
          if (mine) setPick({ blindMine: slot });
          else if (pick && typeof pick === 'object') act({ type: 'BLIND_SWAP', mySlot: pick.blindMine, targetId: ownerId, slot });
          return;
      }
    }
  };

  const slotState = (ownerId: string) => (slot: number): SlotState => {
    const sv = view.players.find((p) => p.id === ownerId)?.slots[slot];
    const rev = revealed[`${ownerId}:${slot}`];
    // Black King: keep the looked-at card visible while the player decides whether to swap.
    // Black King: both cards the player looked at stay visible while they decide whether to swap.
    const deciding =
      myTurn &&
      ((view.abilityPeeked?.playerId === ownerId && view.abilityPeeked.slot === slot) ||
        (ownerId === me && view.abilityPeekedMine === slot));
    const live = rev && deciding ? rev.card : null;
    return {
      card: sv?.card ?? live,
      flipped: false,
      selectable: canTap(ownerId, slot),
      selected:
        (ownerId === me && typeof pick === 'object' && pick !== null && pick.blindMine === slot) ||
        (view.abilityPeeked?.playerId === ownerId && view.abilityPeeked.slot === slot) ||
        (ownerId === me && view.ability === 'look_swap' && view.abilityPeekedMine === slot) ||
        (view.give?.targetId === ownerId && view.give.slot === slot),
    };
  };

  // Phase timer ring: remember when this deadline started to show the fraction left.
  const deadlineStart = useRef<{ deadline: number | null; start: number }>({ deadline: null, start: 0 });
  if (deadlineStart.current.deadline !== view.deadline) deadlineStart.current = { deadline: view.deadline, start: Date.now() };
  const span = view.deadline ? view.deadline - deadlineStart.current.start : 0;
  const left = view.deadline ? Math.max(0, view.deadline - now) : 0;
  const frac = span > 0 ? Math.min(1, left / span) : 0;

  useMusic(); // background music at the table (volume and mute in the sound panel)

  // Sound cues that aren't card movements: your turn starts; the round's cards are revealed.
  const prevCue = useRef({ myTurn: false, phase: view.phase });
  useEffect(() => {
    const turnNow = myTurn && view.phase === 'choose';
    if (turnNow && !prevCue.current.myTurn) playSound('turn', { volume: 0.8 });
    if (view.phase === 'ended' && prevCue.current.phase !== 'ended') playSound('reveal');
    prevCue.current = { myTurn: turnNow, phase: view.phase };
  }, [myTurn, view.phase]);

  // "CABO!" banner when someone calls it (not when rejoining a round where it was already called).
  const prevCabo = useRef(view.caboCalledBy);
  const [caboBanner, setCaboBanner] = useState<string | null>(null);
  useEffect(() => {
    if (view.caboCalledBy && view.caboCalledBy !== prevCabo.current) {
      setCaboBanner(view.caboCalledBy);
      playSound('cabo');
      const t = window.setTimeout(() => setCaboBanner(null), 1600);
      prevCabo.current = view.caboCalledBy;
      return () => window.clearTimeout(t);
    }
    prevCabo.current = view.caboCalledBy;
  }, [view.caboCalledBy]);

  const meIdx = view.players.findIndex((p) => p.id === me);
  // Opponents clockwise from my left: the player after me sits at the left end of the arc.
  const opponents = view.players.length
    ? [...view.players.slice(meIdx + 1), ...view.players.slice(0, Math.max(0, meIdx))]
    : [];
  const mePlayer = view.players[meIdx];

  // Seating: on large screens with 3+ players, opponents sit around the table clockwise from my left
  // (left side bottom→top, across the top, right side top→bottom). Phones keep everyone on top.
  const roomy = useMediaQuery('(min-width: 900px) and (min-height: 560px)');
  const sides = roomy && opponents.length >= 2;
  const perSide = !sides ? 0 : opponents.length >= 5 ? 2 : 1;
  const leftSeats = opponents.slice(0, perSide).reverse();
  const topSeats = opponents.slice(perSide, opponents.length - perSide);
  const rightSeats = opponents.slice(opponents.length - perSide);
  const seat = (p: (typeof opponents)[number], orient: Orient, arc = 0) => (
    <Seat
      key={p.id}
      player={p}
      view={view}
      room={room}
      now={now}
      arc={arc}
      orient={orient}
      state={slotState(p.id)}
      onCard={(slot) => onCard(p.id, slot)}
    />
  );
  const myTurnNow = myTurn && view.phase !== 'ended' && view.phase !== 'peek';
  // Your turn: tap the stock to draw, or the discard to take it (then tap one of your cards).
  const canDraw = myTurn && view.phase === 'choose' && pick !== 'take_discard';
  const canTake = myTurn && view.phase === 'choose' && !!view.discardTop && !!mePlayer?.slots.some(Boolean);

  return (
    <main className="table-screen">
      <header className="tbar">
        <Title size="sm" />
        <div className="tbar__round">Round {room.roundNo}</div>
        {view.caboCalledBy && view.phase !== 'ended' && (
          <div className="tbar__final" title={`CABO called by ${name(view.caboCalledBy)}`}>Final round</div>
        )}
        {view.deadline && view.phase !== 'ended' && view.phase !== 'settle' && !room.paused && <TimerRing frac={frac} seconds={Math.ceil(left / 1000)} />}
        <div className="tbar__spacer" />
        {spectator && <div className="tbar__watching">Watching</div>}
        {room.status === 'playing' && !room.paused && !spectator && (
          <button
            className="btn btn--light btn--sm tbar__icon"
            onClick={() => call((ack) => socket.emit('room:pause', ack))}
            disabled={view.phase === 'snap'}
            aria-label="Pause game"
            title={view.phase === 'snap' ? 'Wait for the snap window to close' : 'Pause the game'}
          >
            <Icon name="pause-button" className="tbar__svg" />
          </button>
        )}
        <SoundControl />
        <button className="btn btn--light btn--sm tbar__icon" onClick={onRules} aria-label="How to play">?</button>
        {spectator ? (
          <button className="btn btn--primary btn--sm" onClick={onLeave}>
            Stop<span className="hide-phone"> watching</span>
          </button>
        ) : (
          <button className="btn btn--primary btn--sm" onClick={() => setConfirmLeave(true)} aria-label="Leave game">
            Leave<span className="hide-phone"> game</span>
          </button>
        )}
      </header>

      <section className={`table ${view.phase === 'snap' ? 'table--snap' : ''} ${sides ? 'table--sides' : ''}`} aria-label="Card table">
        {caboBanner && (
          <div className="cabo-banner" role="status">
            CABO!<small>{name(caboBanner)} called it — last round</small>
          </div>
        )}
        {sides && <div className="seats-side seats-side--left">{leftSeats.map((p) => seat(p, 'left'))}</div>}
        <div className="seats">
          {topSeats.map((p, i) => {
            const mid = (topSeats.length - 1) / 2;
            return seat(p, 'top', topSeats.length > 1 ? Math.abs(i - mid) / mid : 0);
          })}
        </div>
        {sides && <div className="seats-side seats-side--right">{rightSeats.map((p) => seat(p, 'right'))}</div>}

        <div className="felt">
          <div className={`prompt-strip ${myTurnNow || view.phase === 'snap' ? 'prompt-strip--hot' : ''}`}>
            <span className="prompt-strip__text">
              <Prompt view={view} pick={pick} name={name} />
            </span>
          </div>
          <Toasts log={log} now={now} />
          <div className="piles">
            <div className="pile">
              <div className="pile__stack">
                <PlayingCard
                  card={null}
                  size="md"
                  spot="stock"
                  selectable={canDraw}
                  onClick={canDraw ? () => act({ type: 'DRAW_STOCK' }) : undefined}
                  title="Draw from the stock"
                />
              </div>
              <span className="pile__label">Stock · {view.stockCount}</span>
            </div>
            <div className="pile">
              {view.phase === 'ability' && view.ability && (
                <span className="ability-badge" key={view.version}>{ABILITY_BADGE[view.ability]}</span>
              )}
              <PlayingCard
                card={view.discardTop}
                gap={!view.discardTop}
                size="md"
                spot="discard"
                selectable={canTake}
                selected={pick === 'take_discard'}
                onClick={canTake ? () => setPick(pick === 'take_discard' ? null : 'take_discard') : undefined}
                title={pick === 'take_discard' ? 'Cancel taking the discard' : 'Take the discard'}
              />
              <span className="pile__label">Discard</span>
            </div>
            {/* Always rendered (hidden when empty) so drawing never shifts the stock and discard. */}
            <div className={`pile pile--drawn ${view.drawnCard ? '' : 'pile--placeholder'}`} aria-hidden={!view.drawnCard}>
              <PlayingCard card={view.drawnCard} size="md" spot={view.drawnCard ? `held:${me}` : undefined} />
              <span className="pile__label">You drew</span>
            </div>
          </div>
        </div>

        {mePlayer && (
          <div className={`mine ${myTurnNow ? 'mine--turn' : ''}`}>
            <div className="mine__hand" data-seat={me}>
              <div className="seat__plate seat__plate--me">
                <span className="seat__name">{mePlayer.name} (you)</span>
                {view.dealerId === me && <span className="chip-d" title="Dealer">D</span>}
                {view.caboCalledBy === me && <span className="chip-cabo">CABO</span>}
              </div>
              <Hand
                slots={mePlayer.slots}
                size="lg"
                state={slotState(me)}
                onCard={(slot) => onCard(me, slot)}
                showLabels
                ownerName="Your"
                ownerId={me}
              />
            </div>
            <ActionBar
              view={view}
              pick={pick}
              setPick={setPick}
              act={act}
              snapLeft={view.phase === 'snap' && !mySnap ? Math.max(0, 1 - (now - snapWin.current.seenAtWall) / view.snapMs) : 0}
              snapStatus={mySnap}
            />
          </div>
        )}
        {view.result && (
          <RoundResults view={view} room={room} onStart={onStart} onEnd={() => call((ack) => socket.emit('room:end', ack))} />
        )}
        {room.paused && (
          <div className="paused-overlay" role="dialog" aria-labelledby="paused-title">
            <div className="panel paused">
              <h2 id="paused-title" className="heading paused__title">Game paused</h2>
              <p className="paused__by">
                {room.paused.byId === me ? 'You paused the game.' : `${room.paused.byName} paused the game.`} Timers are stopped.
              </p>
              {!spectator && (
                <button className="btn btn--primary" onClick={() => call((ack) => socket.emit('room:resume', ack))} autoFocus>
                  Resume
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <footer className="tfoot">
        <PlayersCard room={room} me={me} now={now} />
        <LogDock log={log} />
      </footer>

      <ConfirmDialog
        open={confirmLeave}
        title="Leave the game?"
        confirmLabel="Leave"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => {
          setConfirmLeave(false);
          onLeave();
        }}
      >
        {room.status === 'playing' ? (
          <p>You'll forfeit this round and your cards leave the table. If only one player is left, they win.</p>
        ) : (
          <p>You'll leave room {room.code}. You can rejoin with the code while it's still open.</p>
        )}
      </ConfirmDialog>
    </main>
  );
}

function TimerRing({ frac, seconds }: { frac: number; seconds: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div className={`timer ${seconds <= 5 ? 'timer--low' : ''}`} role="timer" aria-label={`${seconds} seconds left`}>
      <svg viewBox="0 0 36 36" aria-hidden>
        <circle cx="18" cy="18" r={r} className="timer__track" />
        <circle cx="18" cy="18" r={r} className="timer__fill" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <span>{seconds}</span>
    </div>
  );
}

function Prompt({ view, pick, name }: { view: PlayerView; pick: Pick; name: (id: string) => string }) {
  const me = view.you;
  const myTurn = view.currentPlayerId === me;
  const cur = name(view.currentPlayerId);
  const spectator = !view.players.some((p) => p.id === me);
  switch (view.phase) {
    case 'peek':
      return spectator ? <>Everyone is memorising their two nearest cards…</> : <>Memorise your two nearest cards — they're face-up for now.</>;
    case 'choose':
      if (!myTurn) return <>{cur}'s turn</>;
      if (pick === 'take_discard') return <>Tap one of your cards to swap with the discard (tap the discard again to cancel)</>;
      return <>Your turn — tap the stock to draw, or the discard to take it</>;
    case 'drawn':
      return myTurn ? <>Keep it (tap one of your cards) or discard it</> : <>{cur} is eyeing a drawn card…</>;
    case 'ability':
      if (!myTurn) return <>{cur} is using a special card</>;
      if (view.ability === 'look_swap' && view.abilityPeeked && view.abilityPeekedMine !== null) {
        return view.abilityPeeked.playerId === view.caboCalledBy
          ? <>{name(view.caboCalledBy)} called CABO, so their cards can't be swapped. Keep them.</>
          : <>Swap these two cards, or keep them where they are?</>;
      }
      if (view.ability === 'look_swap' && view.abilityPeeked) return <>Now tap one of your own cards to look at it</>;
      if (view.ability === 'blind_swap' && pick && typeof pick === 'object') {
        return view.caboCalledBy
          ? <>Now tap another player's card (not {name(view.caboCalledBy)}'s, they called CABO) to swap with your #{pick.blindMine + 1}</>
          : <>Now tap another player's card to swap with your #{pick.blindMine + 1}</>;
      }
      return <>{ABILITY_TEXT[view.ability!]} — or skip</>;
    case 'snap': {
      const rank = view.discardTop ? view.discardTop.rank : '';
      if (view.snapOnlyFor === me) return <>You snapped first! Snap another {rank} of yours, or press Done.</>;
      if (view.snapOnlyFor) return <>{name(view.snapOnlyFor)} snapped first and may snap more {rank}s</>;
      return <>Discarded {view.discardTop ? cardLabel(view.discardTop) : ''} — snap a match! Wrong guesses cost a card.</>;
    }
    case 'settle': // R31: snapping opens once the card is back in place
      if (view.lastSettle === 'swap') return <>Cards changing hands… snapping opens in a moment</>;
      return myTurn ? <>Take a good look… snapping opens once your card is back</> : <>{cur} is looking at a card… snapping opens once it's back</>;
    case 'give':
      return view.give!.snapperId === me
        ? <>You snapped {name(view.give!.targetId)}'s card — tap one of yours to give them, or skip</>
        : <>{name(view.give!.snapperId)} may hand {name(view.give!.targetId)} a card</>;
    case 'ended':
      return <>Round over — all cards revealed</>;
  }
}
