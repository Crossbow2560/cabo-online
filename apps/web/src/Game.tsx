import { useEffect, useRef, useState } from 'react';
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
import { Title } from './components/Title';
import { useNow } from './lib/useNow';

type Call = <T>(fn: (ack: (r: Ack<T>) => void) => void) => Promise<Ack<T>>;

const REVEAL_MS = 3000;

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
  const myTurn = view.currentPlayerId === me;
  const name = (id: string) => view.players.find((p) => p.id === id)?.name ?? 'a player who left';

  useEffect(() => setPick(null), [view.phase, view.currentPlayerId, view.abilityPeeked]);

  // Private peek results flip the card face-up in place for a few seconds.
  useEffect(() => {
    const fresh = log.filter((l) => l.id > seenLog.current);
    if (!fresh.length) return;
    seenLog.current = fresh.at(-1)!.id;
    const add: Record<string, { card: Card; until: number }> = {};
    for (const l of fresh) if (l.reveal && l.to === me) add[`${l.reveal.playerId}:${l.reveal.slot}`] = { card: l.reveal.card, until: Date.now() + REVEAL_MS };
    if (Object.keys(add).length) setRevealed((r) => ({ ...r, ...add }));
  }, [log, me]);

  const act = (action: ClientAction) =>
    call((ack) => socket.emit('game:action', { ...action, expectedVersion: view.version } as ClientAction, ack)).then(() => setPick(null));

  const snap = (ownerId: string, slot: number) =>
    call((ack) => socket.emit('game:snap', { windowId: view.snapWindowId!, ownerId, slot }, ack));

  /** Which cards are a valid tap right now — mirrors onCard. */
  const canTap = (ownerId: string, slot: number): boolean => {
    const s = view.players.find((p) => p.id === ownerId)?.slots[slot];
    if (!s) return false;
    const mine = ownerId === me;
    if (view.phase === 'snap') return true;
    if (view.phase === 'give') return view.give?.snapperId === me && mine;
    if (!myTurn) return false;
    if (view.phase === 'choose') return pick === 'take_discard' && mine;
    if (view.phase === 'drawn') return mine;
    if (view.phase === 'ability') {
      switch (view.ability) {
        case 'peek_own': return mine;
        case 'peek_other': return !mine;
        case 'look_swap': return view.abilityPeeked ? mine : !mine;
        case 'blind_swap': return mine || (pick !== null && typeof pick === 'object');
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
          else if (view.abilityPeeked && mine) act({ type: 'SWAP', mySlot: slot });
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
    const deciding = myTurn && view.abilityPeeked?.playerId === ownerId && view.abilityPeeked.slot === slot;
    const live = rev && (rev.until > now || deciding) ? rev.card : null;
    return {
      card: sv?.card ?? live,
      flipped: !!live && !sv?.card,
      selectable: canTap(ownerId, slot),
      selected:
        (ownerId === me && typeof pick === 'object' && pick !== null && pick.blindMine === slot) ||
        (view.abilityPeeked?.playerId === ownerId && view.abilityPeeked.slot === slot) ||
        (view.give?.targetId === ownerId && view.give.slot === slot),
    };
  };

  // Phase timer ring: remember when this deadline started to show the fraction left.
  const deadlineStart = useRef<{ deadline: number | null; start: number }>({ deadline: null, start: 0 });
  if (deadlineStart.current.deadline !== view.deadline) deadlineStart.current = { deadline: view.deadline, start: Date.now() };
  const span = view.deadline ? view.deadline - deadlineStart.current.start : 0;
  const left = view.deadline ? Math.max(0, view.deadline - now) : 0;
  const frac = span > 0 ? Math.min(1, left / span) : 0;

  const meIdx = view.players.findIndex((p) => p.id === me);
  // Opponents clockwise from my left: the player after me sits at the left end of the arc.
  const opponents = view.players.length
    ? [...view.players.slice(meIdx + 1), ...view.players.slice(0, Math.max(0, meIdx))]
    : [];
  const mePlayer = view.players[meIdx];
  const myTurnNow = myTurn && view.phase !== 'ended' && view.phase !== 'peek';

  return (
    <main className="table-screen">
      <header className="tbar">
        <Title size="sm" />
        <div className="tbar__round">Round {room.roundNo}</div>
        {view.deadline && view.phase !== 'ended' && <TimerRing frac={frac} seconds={Math.ceil(left / 1000)} />}
        <div className="tbar__spacer" />
        <button className="btn btn--light btn--sm tbar__icon" onClick={onRules} aria-label="How to play">?</button>
        <button className="btn btn--primary btn--sm" onClick={() => setConfirmLeave(true)}>Leave game</button>
      </header>

      <section className={`table ${view.phase === 'snap' ? 'table--snap' : ''}`} aria-label="Card table">
        <div className="seats">
          {opponents.map((p, i) => {
            const mid = (opponents.length - 1) / 2;
            const arc = opponents.length > 1 ? Math.abs(i - mid) / mid : 0;
            return (
              <Seat
                key={p.id}
                player={p}
                view={view}
                room={room}
                now={now}
                arc={arc}
                state={slotState(p.id)}
                onCard={(slot) => onCard(p.id, slot)}
              />
            );
          })}
        </div>

        <div className="felt">
          <div className={`prompt-strip ${myTurnNow || view.phase === 'snap' ? 'prompt-strip--hot' : ''}`}>
            <Prompt view={view} pick={pick} name={name} />
            {view.caboCalledBy && view.phase !== 'ended' && (
              <span className="prompt-strip__cabo">CABO called by {name(view.caboCalledBy)} — final round</span>
            )}
          </div>
          <Toasts log={log} now={now} />
          <div className="piles">
            <div className="pile">
              <div className="pile__stack">
                <PlayingCard card={null} size="md" />
              </div>
              <span className="pile__label">Stock · {view.stockCount}</span>
            </div>
            <div className="pile">
              <PlayingCard card={view.discardTop} gap={!view.discardTop} size="md" />
              <span className="pile__label">Discard</span>
            </div>
            {view.drawnCard && (
              <div className="pile pile--drawn">
                <PlayingCard card={view.drawnCard} size="md" />
                <span className="pile__label">You drew</span>
              </div>
            )}
          </div>
        </div>

        {mePlayer && (
          <div className={`mine ${myTurnNow ? 'mine--turn' : ''}`}>
            <div className="mine__hand">
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
              />
            </div>
            <ActionBar view={view} pick={pick} setPick={setPick} act={act} snapLeft={view.phase === 'snap' ? frac : 0} />
          </div>
        )}
        {view.result && <RoundResults view={view} room={room} onStart={onStart} />}
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
  switch (view.phase) {
    case 'peek':
      return <>Memorise your two nearest cards — they're face-up for now.</>;
    case 'choose':
      if (!myTurn) return <>{cur}'s turn</>;
      if (pick === 'take_discard') return <>Tap one of your cards to swap with the discard</>;
      return <>Your turn — draw, take the discard, or call CABO</>;
    case 'drawn':
      return myTurn ? <>Keep it (tap one of your cards) or discard it</> : <>{cur} is eyeing a drawn card…</>;
    case 'ability':
      if (!myTurn) return <>{cur} is using a special card</>;
      if (view.ability === 'look_swap' && view.abilityPeeked) return <>Tap one of your cards to swap with it — or skip</>;
      if (view.ability === 'blind_swap' && pick && typeof pick === 'object') return <>Now tap another player's card to swap with your #{pick.blindMine + 1}</>;
      return <>{ABILITY_TEXT[view.ability!]} — or skip</>;
    case 'snap':
      return <>Discarded {view.discardTop ? cardLabel(view.discardTop) : ''} — snap a match! Wrong guesses cost a card.</>;
    case 'give':
      return view.give!.snapperId === me
        ? <>You snapped {name(view.give!.targetId)}'s card — tap one of yours to give them, or skip</>
        : <>{name(view.give!.snapperId)} may hand {name(view.give!.targetId)} a card</>;
    case 'ended':
      return <>Round over — all cards revealed</>;
  }
}
