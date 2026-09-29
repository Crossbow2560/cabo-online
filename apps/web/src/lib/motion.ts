import type { Card, Motion, Spot } from '@cabo/engine';
import lawStar from '../assets/icons/law-star.svg?raw';

/**
 * Card movement animations.
 *
 * The server sends a public `motion` with each event (e.g. "held → Ana's slot 2, Ana's slot 2 →
 * discard"). Events arrive just before the new table view, so `captureMotion` records how the table
 * looks *now* (where each card is and what it looks like). After the table re-renders,
 * `playMotions` flies each card from its old look/place to its new one — turning it over in the air
 * when it goes from face-down to face-up or back — then marks the card that changed.
 */

const FLY_MS = 600;
const STAGGER_MS = 150;
const SETTLE_MS = 280;
const CHANGED_MS = 2600;
const STALE_MS = 2500;
const PEEK_MS = 5600; // peeker: lift → flip up → hold ~4.4s → flip down → return
const PEEK_WATCH_MS = 2800; // everyone else: card lifts toward the peeker and comes back
const REVEAL_HOLD_MS = 4400; // reduced-motion fallback for the peeker
const SWAP_MS = 1600; // swaps: both cards lift and glow in place, then cross slowly
const SWAP_LIFT = 0.47; // fraction of SWAP_MS spent lifted in place (~750ms) before crossing
const SWAP_CHANGED_MS = CHANGED_MS + 750;

interface CapturedMove {
  from: Spot;
  to: Spot;
  card?: Card;
  fromRect: DOMRect | null;
  fromTurn: number; // degrees the source card is turned (side seats)
  fromLook: HTMLElement | null; // clone of the source card as it looked
  toPrevLook: HTMLElement | null; // clone of the destination before the change (underlay)
}

interface Pending {
  at: number;
  moves: CapturedMove[];
  flash: { spot: Spot; card?: Card }[];
  peek: { spot: Spot; by: string; look: HTMLElement | null }[];
  reveals: Map<string, Card>;
  snapshot: Map<string, DOMRect>;
}

const queue: Pending[] = [];

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const animationsOff = () => reducedMotion() || document.hidden;

export function spotKey(spot: Spot): string {
  switch (spot.at) {
    case 'slot': return `slot:${spot.playerId}:${spot.slot}`;
    case 'held': return `held:${spot.playerId}`;
    default: return spot.at;
  }
}

function cardEl(spot: Spot): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-spot="${spotKey(spot)}"]`);
}

/** How far a card is turned on screen: side seats show their cards at ±90° (see Hand). */
function turnOf(el: Element | null | undefined): number {
  return Number(el?.closest<HTMLElement>('[data-turn]')?.dataset.turn ?? 0);
}

/**
 * A card's box as if it were upright (same centre), so flights can size a portrait card and
 * rotate it by `turnOf` instead. For an unturned card this is just its bounding box.
 */
function boxOf(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  if (turnOf(el) % 180 === 0) return r;
  return new DOMRect(r.left + (r.width - r.height) / 2, r.top + (r.height - r.width) / 2, r.height, r.width);
}

/** The card an opponent's held card stands in for (it has no element of its own). */
const heldSample = (spot: Spot) =>
  spot.at === 'held' ? document.querySelector<HTMLElement>(`[data-seat="${spot.playerId}"] .pcard`) : null;

/** Where a spot is on screen (upright box). An opponent's held card: a card-sized box on their seat. */
function rectOf(spot: Spot): DOMRect | null {
  const el = cardEl(spot);
  if (el) return boxOf(el);
  if (spot.at !== 'held') return null;
  const seat = document.querySelector<HTMLElement>(`[data-seat="${spot.playerId}"]`);
  const sample = heldSample(spot);
  if (!seat || !sample) return null;
  const s = seat.getBoundingClientRect();
  const c = boxOf(sample);
  return new DOMRect(s.left + (s.width - c.width) / 2, s.top + (s.height - c.height) / 2, c.width, c.height);
}

const turnAt = (spot: Spot) => turnOf(cardEl(spot) ?? heldSample(spot));

/**
 * Flyers scale from their top-left corner (transform-origin 0 0, so translate/scale line up with
 * measured rects); a turn must still pivot on the card's centre, or it swings off course.
 */
const turnAbout = (r: DOMRect, deg: number) =>
  `translate(${r.width / 2}px, ${r.height / 2}px) rotate(${deg}deg) translate(${-r.width / 2}px, ${-r.height / 2}px)`;

/** A screen-space offset expressed inside a card turned by `deg` (for animating the card itself). */
function unturn(dx: number, dy: number, deg: number): [number, number] {
  if (!deg) return [dx, dy];
  const a = (-deg * Math.PI) / 180;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}

/** A detached copy of a card's current look (without interaction/animation state). */
function lookOf(el: HTMLElement | null): HTMLElement | null {
  if (!el || el.classList.contains('pcard--gap')) return null;
  const c = el.cloneNode(true) as HTMLElement;
  for (const a of ['data-spot', 'data-changed', 'data-flash', 'disabled', 'aria-label', 'title', 'role']) c.removeAttribute(a);
  c.classList.remove('pcard--selectable', 'pcard--selected', 'pcard--flipped');
  c.style.cssText = '';
  return c;
}

/**
 * Layout position for the settle glide, measured on the card's wrapper: the card itself may be
 * mid-animation or lifted by hover/selection, which would register as fake movement.
 */
const layoutRect = (el: HTMLElement) => (el.parentElement ?? el).getBoundingClientRect();

function snapshotAll(): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>();
  document.querySelectorAll<HTMLElement>('[data-spot]').forEach((el) => m.set(el.dataset.spot!, layoutRect(el)));
  return m;
}

/** Called as soon as a public event arrives (the screen still shows the previous state). */
export function captureMotion(motion: Motion) {
  queue.push({
    at: performance.now(),
    moves: (motion.moves ?? []).map((m) => ({
      ...m,
      fromRect: rectOf(m.from),
      fromTurn: turnAt(m.from),
      fromLook: lookOf(cardEl(m.from)),
      toPrevLook: lookOf(cardEl(m.to)),
    })),
    flash: motion.flash ?? [],
    peek: (motion.peek ?? []).map((p) => ({ ...p, look: lookOf(cardEl(p.spot)) })),
    reveals: new Map(),
    // Only the first event of a batch sees the true "before" layout; later ones reuse it.
    snapshot: queue.length ? queue[0].snapshot : snapshotAll(),
  });
}

/** A private peek result for this player; attached to the peek that caused it. */
export function captureReveal(reveal: { playerId: string; slot: number; card: Card }) {
  const key = spotKey({ at: 'slot', playerId: reveal.playerId, slot: reveal.slot });
  const target = [...queue].reverse().find((p) => p.peek.some((pk) => spotKey(pk.spot) === key));
  target?.reveals.set(key, reveal.card);
}

/** Called after the table re-renders with the new state. `me` = this viewer's player id. */
export function playMotions(me: string) {
  const now = performance.now();
  const items = queue.splice(0).filter((p) => now - p.at < STALE_MS);
  if (!items.length) return;

  // Cards being flown onto (hidden until they land) or peeked at don't also glide; everything else
  // that moved because the layout changed (including piles a card just left) does.
  const busy = new Set<string>();
  for (const p of items) {
    for (const m of p.moves) busy.add(spotKey(m.to));
    for (const pk of p.peek) busy.add(spotKey(pk.spot));
  }
  settle(items[0].snapshot, busy);

  // Events play one after another (e.g. the reshuffle, then the draw that needed it).
  let offset = 0;
  for (const p of items) {
    const sources = new Set(p.moves.map((m) => spotKey(m.from)));
    let span = 0;
    if (isSwap(p.moves)) {
      // Both cards lift together so everyone can see which two are trading places, then cross.
      p.moves.forEach((m, i) => fly({ ...m, arc: i === 0 ? 1 : -1, swap: true }, offset));
      span = SWAP_MS;
    } else {
      p.moves.forEach((m, i) => {
        const underlay = m.to.at === 'discard' && !sources.has('discard') ? m.toPrevLook : null;
        fly({ ...m, underlay, arc: i % 2 === 0 ? 1 : -1 }, offset + i * STAGGER_MS);
        span = Math.max(span, i * STAGGER_MS + FLY_MS);
      });
    }
    for (const f of p.flash) {
      window.setTimeout(() => flash(f.spot, f.card), offset);
      span = Math.max(span, 400);
    }
    for (const pk of p.peek) {
      const card = p.reveals.get(spotKey(pk.spot));
      if (pk.by === me && card) peekAsViewer(pk.spot, pk.look, card, offset);
      else peekAsOnlooker(pk.spot, pk.by, offset);
    }
    offset += span;
  }
}

/** Deal at the start of a round: every slot flies in from the stock, then the first discard turns up. */
export function playDeal(playerIds: string[], slotsPerPlayer: number) {
  const stock = cardEl({ at: 'stock' });
  const from = stock?.getBoundingClientRect() ?? null;
  const look = lookOf(stock);
  if (!from) return;
  let n = 0;
  for (let k = 0; k < slotsPerPlayer; k++) {
    for (const playerId of playerIds) {
      fly({ from: { at: 'stock' }, to: { at: 'slot', playerId, slot: k }, fromRect: from, fromTurn: 0, fromLook: look, markChanged: false }, n++ * 55);
    }
  }
  fly({ from: { at: 'stock' }, to: { at: 'discard' }, fromRect: from, fromTurn: 0, fromLook: look, markChanged: false }, n * 55 + 120);
}

// ---------------------------------------------------------------- flights

/** Two cards trading slots (blind swap, look & swap). */
function isSwap(moves: CapturedMove[]) {
  if (moves.length !== 2) return false;
  const [a, b] = moves;
  return a.from.at === 'slot' && a.to.at === 'slot' && spotKey(a.from) === spotKey(b.to) && spotKey(a.to) === spotKey(b.from);
}

interface Flight {
  swap?: boolean;
  from: Spot;
  to: Spot;
  card?: Card;
  fromRect: DOMRect | null;
  fromTurn: number;
  fromLook: HTMLElement | null;
  underlay?: HTMLElement | null;
  arc?: number;
  markChanged?: boolean;
}

/**
 * Jump any of *our* running animations on a card (e.g. a turn-over) to their end before we measure
 * and cover it. CSS animations (like the looping snap-window glow) are left alone: finishing an
 * infinite animation throws.
 */
function settleNow(el: HTMLElement | null) {
  for (const a of el?.getAnimations() ?? []) {
    if (a instanceof CSSAnimation || a instanceof CSSTransition) continue;
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end !== 'number' || !Number.isFinite(end)) continue;
    try {
      a.finish();
    } catch {
      /* already finished or not finishable: ignore */
    }
  }
}

function fly(f: Flight, delay: number) {
  const markChanged = f.markChanged ?? true;
  const target = cardEl(f.to);
  settleNow(target);
  const toRect = target ? boxOf(target) : rectOf(f.to);
  const t0 = f.fromTurn;
  const t1 = turnAt(f.to);
  const tMid = (t0 + t1) / 2;
  if (!toRect || toRect.width === 0) return;
  if (animationsOff() || !f.fromRect) {
    if (target && markChanged) window.setTimeout(() => mark(target), delay);
    return;
  }

  const size = sizeOf(target) ?? 'md';
  // No card on screen to copy (an opponent's held card): it was face-down to us, unless it came
  // off the (public) discard pile.
  const start = f.fromLook ?? buildCard(f.from.at === 'discard' ? f.card : undefined, size);
  const end = lookOf(target) ?? buildCard(undefined, size);
  const turns = isFace(start) !== isFace(end);
  const flyer = twoSided(start, end, size, toRect);
  const under = f.underlay ? placed(f.underlay, size, toRect, 48, t1) : null;
  if (under) layer().appendChild(under);
  layer().appendChild(flyer);

  if (target) target.style.visibility = 'hidden';
  const dx = f.fromRect.left - toRect.left;
  const dy = f.fromRect.top - toRect.top;
  const s = f.fromRect.width / toRect.width;
  const lift = Math.min(70, 16 + Math.hypot(dx, dy) * 0.18) * (f.arc ?? 1);
  const tilt = (dx > 0 ? -6 : 6) * (f.arc ?? 1);
  const at = `translate(${dx}px, ${dy}px) scale(${s}) ${turnAbout(toRect, t0)}`;
  // Every keyframe uses the same function list (translate, scale, turn), so the browser interpolates
  // each one smoothly instead of falling back to matrix interpolation, which warps turned cards.
  const home = `translate(0px, 0px) scale(1) ${turnAbout(toRect, t1)}`;
  const rest = 'drop-shadow(0 3px 0 var(--saddle-deep))';
  const glow = 'drop-shadow(0 0 3px var(--cream)) drop-shadow(0 0 10px var(--sand)) drop-shadow(0 12px 10px var(--saddle-soft))';
  const duration = f.swap ? SWAP_MS : FLY_MS;
  const keyframes: Keyframe[] = f.swap
    ? [
        // lift + glow in place (~750ms) so it's clear which cards are swapping...
        { transform: at, filter: rest },
        { offset: 0.12, transform: `translate(${dx}px, ${dy - 12}px) scale(${s * 1.18}) ${turnAbout(toRect, t0)}`, filter: glow },
        { offset: SWAP_LIFT, transform: `translate(${dx}px, ${dy - 12}px) scale(${s * 1.18}) ${turnAbout(toRect, t0)}`, filter: glow },
        // ...then cross on opposite arcs
        {
          offset: SWAP_LIFT + (1 - SWAP_LIFT) / 2,
          transform: `translate(${dx * 0.5}px, ${dy * 0.5 - lift * 1.4}px) scale(${((s + 1) / 2) * 1.2}) ${turnAbout(toRect, tMid + tilt)}`,
          filter: glow,
        },
        { transform: home, filter: rest },
      ]
    : [
        { transform: at, filter: rest },
        {
          offset: 0.5,
          transform: `translate(${dx * 0.45}px, ${dy * 0.45 - lift}px) scale(${((s + 1) / 2) * 1.14}) ${turnAbout(toRect, tMid + tilt)}`,
          filter: 'drop-shadow(0 18px 14px var(--saddle-soft))',
        },
        { transform: home, filter: rest, ...(target ? {} : { opacity: 0 }) },
      ];
  const move = flyer.animate(keyframes, { duration, delay, easing: f.swap ? 'ease-in-out' : 'cubic-bezier(.3,.7,.25,1)', fill: 'backwards' });
  const inner = flyer.firstElementChild as HTMLElement;
  if (turns) {
    inner.animate(
      [{ transform: 'rotateY(0deg)' }, { offset: 0.3, transform: 'rotateY(0deg)' }, { offset: 0.72, transform: 'rotateY(180deg)' }, { transform: 'rotateY(180deg)' }],
      { duration, delay, easing: 'ease-in-out', fill: 'both' },
    );
  } else {
    (inner.lastElementChild as HTMLElement).style.display = 'none';
  }

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    flyer.remove();
    under?.remove();
    if (target) {
      target.style.visibility = '';
      if (markChanged) mark(target, f.swap ? SWAP_CHANGED_MS : CHANGED_MS);
    }
  };
  move.finished.then(done, done);
  window.setTimeout(done, delay + duration + 400); // safety net: never leave a card hidden
}

/** Cards that shifted because the layout changed (new penalty column, piles re-centring) glide over. */
function settle(before: Map<string, DOMRect>, busy: Set<string>) {
  if (animationsOff()) return;
  document.querySelectorAll<HTMLElement>('[data-spot]').forEach((el) => {
    const key = el.dataset.spot!;
    const old = before.get(key);
    if (!old || busy.has(key)) return;
    const now = layoutRect(el);
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const [x, y] = unturn(dx, dy, turnOf(el));
    el.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], { duration: SETTLE_MS, easing: 'ease-out' });
  });
}

// ---------------------------------------------------------------- peeks

/** The peeker: the card lifts over their hand, turns up, is held a moment, turns down, goes back. */
function peekAsViewer(spot: Spot, look: HTMLElement | null, card: Card, delay: number) {
  window.setTimeout(() => {
    const target = cardEl(spot);
    if (!target) return;
    settleNow(target);
    const r = boxOf(target);
    const turn = turnOf(target);
    const size = sizeOf(target) ?? 'md';
    if (animationsOff()) {
      const face = placed(buildCard(card, size), size, r, 55, turn);
      layer().appendChild(face);
      face.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], { duration: REVEAL_HOLD_MS });
      window.setTimeout(() => face.remove(), REVEAL_HOLD_MS);
      return;
    }
    // Look & swap keeps the card face-up afterwards (the player is deciding), so don't turn it back.
    const staysUp = isFace(target);
    const view = viewingRect(r);
    const flyer = twoSided(look ?? buildCard(undefined, size), buildCard(card, size), size, view);
    flyer.classList.add('flyer--peek');
    layer().appendChild(flyer);
    target.style.visibility = 'hidden';
    const at = `translate(${r.left - view.left}px, ${r.top - view.top}px) scale(${r.width / view.width}) ${turnAbout(view, turn)}`;
    const move = flyer.animate(
      [
        { transform: at },
        { offset: 0.084, transform: `translate(0px, -6px) scale(1) ${turnAbout(view, -2)}` },
        { offset: 0.91, transform: `translate(0px, 0px) scale(1) ${turnAbout(view, 1)}` },
        { transform: at },
      ],
      { duration: PEEK_MS, easing: 'ease-in-out' },
    );
    (flyer.firstElementChild as HTMLElement).animate(
      staysUp
        ? [{ transform: 'rotateY(0)' }, { offset: 0.077, transform: 'rotateY(0)' }, { offset: 0.154, transform: 'rotateY(180deg)' }, { transform: 'rotateY(180deg)' }]
        : [
            { transform: 'rotateY(0)' },
            { offset: 0.077, transform: 'rotateY(0)' },
            { offset: 0.154, transform: 'rotateY(180deg)' },
            { offset: 0.833, transform: 'rotateY(180deg)' },
            { offset: 0.91, transform: 'rotateY(0)' },
            { transform: 'rotateY(0)' },
          ],
      { duration: PEEK_MS, easing: 'ease-in-out', fill: 'both' },
    );
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      flyer.remove();
      target.style.visibility = '';
    };
    move.finished.then(done, done);
    window.setTimeout(done, PEEK_MS + 400);
  }, delay);
}

/** Everyone else: the card lifts, tips toward whoever is looking at it, then settles back. */
function peekAsOnlooker(spot: Spot, by: string, delay: number) {
  window.setTimeout(() => {
    const el = cardEl(spot);
    if (!el) return;
    if (animationsOff()) {
      el.setAttribute('data-flash', '');
      window.setTimeout(() => el.removeAttribute('data-flash'), 1200);
      return;
    }
    const r = el.getBoundingClientRect();
    const seat = document.querySelector<HTMLElement>(`[data-seat="${by}"]`)?.getBoundingClientRect();
    const tx = seat ? (seat.left + seat.width / 2 - (r.left + r.width / 2)) * 0.35 : 0;
    const ty = seat ? (seat.top + seat.height / 2 - (r.top + r.height / 2)) * 0.35 : -r.height * 0.4;
    const [x, y] = unturn(tx, ty - 8, turnOf(el));
    const lifted = `translate(${x}px, ${y}px) rotate(${tx > 0 ? 8 : -8}deg) scale(1.15)`;
    const shadow = 'drop-shadow(0 10px 8px var(--saddle-soft))';
    el.animate(
      [
        { transform: 'none' },
        { offset: 0.25, transform: lifted, filter: shadow },
        { offset: 0.72, transform: lifted, filter: shadow },
        { transform: 'none' },
      ],
      { duration: PEEK_WATCH_MS, easing: 'ease-in-out' },
    );
  }, delay);
}

/** Where the peeker holds a card up to look at it: just above their own hand, a bit larger. */
function viewingRect(card: DOMRect): DOMRect {
  const hand = document.querySelector<HTMLElement>('.mine__hand')?.getBoundingClientRect();
  const sample = document.querySelector<HTMLElement>('.mine .pcard')?.getBoundingClientRect();
  const w = Math.min((sample?.width ?? card.width * 1.6) * 1.4, window.innerWidth * 0.3, 130);
  const h = w * 1.4;
  const cx = hand ? hand.left + hand.width / 2 : window.innerWidth / 2;
  const top = hand ? Math.max(8, hand.top - h * 0.55) : window.innerHeight / 2 - h / 2;
  return new DOMRect(Math.min(Math.max(8, cx - w / 2), window.innerWidth - w - 8), Math.min(top, window.innerHeight - h - 8), w, h);
}

// ---------------------------------------------------------------- wrong snap + changed marker

/** A lingering glow on a card that just changed, so players can see what was replaced. */
function mark(el: HTMLElement, ms = CHANGED_MS) {
  el.removeAttribute('data-changed');
  void el.offsetWidth; // restart the CSS animation
  el.style.setProperty('--changed-ms', `${ms}ms`);
  el.setAttribute('data-changed', '');
  window.setTimeout(() => el.removeAttribute('data-changed'), ms);
}

/** Wrong snap: wiggle the card and show its face to everyone for a moment. */
function flash(spot: Spot, card?: Card) {
  const el = cardEl(spot);
  if (!el || document.hidden) return;
  el.removeAttribute('data-flash');
  void el.offsetWidth;
  el.setAttribute('data-flash', '');
  window.setTimeout(() => el.removeAttribute('data-flash'), 1000);
  if (!card) return;
  const r = boxOf(el);
  const turn = `rotate(${turnOf(el)}deg)`;
  const size = sizeOf(el) ?? 'md';
  const face = placed(buildCard(card, size), size, r, 49);
  layer().appendChild(face);
  const anim = face.animate(
    [
      { transform: `${turn} rotateY(90deg)`, offset: 0 },
      { transform: `${turn} rotateY(0deg)`, offset: 0.12 },
      { transform: `${turn} rotateY(0deg)`, offset: 0.88 },
      { transform: `${turn} rotateY(90deg)`, offset: 1 },
    ],
    { duration: 1800, easing: 'ease-in-out' },
  );
  anim.finished.then(() => face.remove(), () => face.remove());
  window.setTimeout(() => face.remove(), 2400);
}

// ---------------------------------------------------------------- DOM helpers

let layerEl: HTMLElement | null = null;
function layer(): HTMLElement {
  if (!layerEl || !layerEl.isConnected) {
    layerEl = document.createElement('div');
    layerEl.className = 'motion-layer';
    layerEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layerEl);
  }
  return layerEl;
}

const sizeOf = (el: HTMLElement | null) => el?.className.match(/pcard--(sm|md|lg)/)?.[1] ?? null;
const isFace = (el: HTMLElement) => el.classList.contains('pcard--face');

/** Resize a card look to `size` at a given pixel width. */
function fit(el: HTMLElement, size: string, width: number) {
  el.classList.remove('pcard--sm', 'pcard--md', 'pcard--lg');
  el.classList.add(`pcard--${size}`);
  el.style.setProperty('--w', `${width}px`);
  el.style.width = `${width}px`;
  el.style.margin = '0';
  return el;
}

/** A card look fixed at a screen rect (underlay / reveal overlay). */
function placed(look: HTMLElement, size: string, r: DOMRect, z: number, turn = 0) {
  const el = fit(look.cloneNode(true) as HTMLElement, size, r.width);
  Object.assign(el.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, zIndex: String(z), pointerEvents: 'none' });
  if (turn) el.style.transform = `rotate(${turn}deg)`;
  return el;
}

/** A card with two sides (start look, end look) that can turn over in flight. */
function twoSided(start: HTMLElement, end: HTMLElement, size: string, r: DOMRect) {
  const flyer = document.createElement('div');
  flyer.className = 'flyer';
  Object.assign(flyer.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const inner = document.createElement('div');
  inner.className = 'flyer__inner';
  const a = fit(start.cloneNode(true) as HTMLElement, size, r.width);
  const b = fit(end.cloneNode(true) as HTMLElement, size, r.width);
  a.classList.add('flyer__side');
  b.classList.add('flyer__side', 'flyer__side--back');
  inner.append(a, b);
  flyer.append(inner);
  return flyer;
}

const SUIT: Record<string, string> = { S: '♠', C: '♣', H: '♥', D: '♦' };

/** Same markup as <PlayingCard>, built by hand for the animation layer. */
function buildCard(card: Card | undefined, size: string): HTMLElement {
  const el = document.createElement('div');
  if (!card) {
    el.className = `pcard pcard--${size} pcard--back`;
    el.innerHTML = `<span class="pcard__back"><span class="pcard__back-icon" style="display:inline-block">${lawStar}</span></span>`;
    return el;
  }
  const red = card.suit === 'H' || card.suit === 'D';
  el.className = `pcard pcard--${size} pcard--face${red ? ' pcard--red' : ''}`;
  if (card.rank === 'JOKER') {
    el.innerHTML = `<span class="pcard__corner">★</span><span class="pcard__joker"><span class="pcard__joker-icon" style="display:inline-block">${lawStar}</span><span>JOKER</span></span><span class="pcard__corner pcard__corner--br">★</span>`;
    return el;
  }
  const s = SUIT[card.suit!];
  el.innerHTML = `<span class="pcard__corner">${card.rank}<br>${s}</span><span class="pcard__pip">${s}</span><span class="pcard__corner pcard__corner--br">${card.rank}<br>${s}</span>`;
  return el;
}
