import type { Card, Motion, Spot } from '@cabo/engine';
import lawStar from '../assets/icons/law-star.svg?raw';

/**
 * Card movement animations.
 *
 * The server sends a public `motion` with each event (e.g. "held → Ana's slot 2, Ana's slot 2 →
 * discard"). Events arrive just before the new table view, so `captureMotion` records where each
 * card starts on the *current* screen; after the table re-renders, `playMotions` flies a card from
 * there to its destination and marks the slot that changed.
 */

const FLY_MS = 560;
const STAGGER_MS = 140;
const CHANGED_MS = 2600;
const STALE_MS = 2500;

interface Pending {
  at: number;
  moves: { from: Spot; to: Spot; card?: Card; fromRect: DOMRect | null }[];
  flash: { spot: Spot; card?: Card }[];
}

const queue: Pending[] = [];

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

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

/** Where a spot is on screen. An opponent's held card has no element: use a card-sized box on their seat. */
function rectOf(spot: Spot): DOMRect | null {
  const el = cardEl(spot);
  if (el) return el.getBoundingClientRect();
  if (spot.at !== 'held') return null;
  const seat = document.querySelector<HTMLElement>(`[data-seat="${spot.playerId}"]`);
  const sample = seat?.querySelector<HTMLElement>('.pcard');
  if (!seat || !sample) return null;
  const s = seat.getBoundingClientRect();
  const c = sample.getBoundingClientRect();
  return new DOMRect(s.left + (s.width - c.width) / 2, s.top + (s.height - c.height) / 2, c.width, c.height);
}

/** Called as soon as an event arrives (the screen still shows the previous state). */
export function captureMotion(motion: Motion) {
  queue.push({
    at: performance.now(),
    moves: (motion.moves ?? []).map((m) => ({ ...m, fromRect: rectOf(m.from) })),
    flash: motion.flash ?? [],
  });
}

/** Called after the table re-renders with the new state. */
export function playMotions() {
  const now = performance.now();
  const items = queue.splice(0).filter((p) => now - p.at < STALE_MS);
  for (const p of items) {
    p.moves.forEach((m, i) => fly(m.fromRect, m.to, m.card, i * STAGGER_MS));
    for (const f of p.flash) flash(f.spot, f.card);
  }
}

/** Deal animation at the start of a round: every slot flies in from the stock. */
export function playDeal(playerIds: string[], slotsPerPlayer: number) {
  const stock = rectOf({ at: 'stock' });
  if (!stock) return;
  let n = 0;
  for (let k = 0; k < slotsPerPlayer; k++) {
    for (const playerId of playerIds) fly(stock, { at: 'slot', playerId, slot: k }, undefined, n++ * 45, false);
  }
}

function fly(fromRect: DOMRect | null, to: Spot, card: Card | undefined, delay: number, markChanged = true) {
  const target = cardEl(to);
  const toRect = target?.getBoundingClientRect() ?? rectOf(to);
  if (!toRect || toRect.width === 0) return;
  // Hidden tabs pause animations; don't leave real cards invisible or pile up flights.
  if (reducedMotion() || !fromRect || document.hidden) {
    if (target && markChanged) mark(target);
    return;
  }

  const size = target?.className.match(/pcard--(sm|md|lg)/)?.[1] ?? 'md';
  const el = buildCard(card, size, toRect.width);
  Object.assign(el.style, {
    position: 'fixed',
    left: `${toRect.left}px`,
    top: `${toRect.top}px`,
    width: `${toRect.width}px`,
    margin: '0',
    zIndex: '50',
    pointerEvents: 'none',
    transformOrigin: '0 0',
  });
  layer().appendChild(el);

  // Hide the real card until the flying one lands on it.
  if (target) target.style.visibility = 'hidden';
  const dx = fromRect.left - toRect.left;
  const dy = fromRect.top - toRect.top;
  const s = fromRect.width / toRect.width;
  const lift = Math.min(60, Math.hypot(dx, dy) * 0.18);
  const anim = el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${s})`, boxShadow: '0 3px 0 var(--saddle-deep)' },
      {
        offset: 0.55,
        transform: `translate(${dx * 0.4}px, ${dy * 0.4 - lift}px) scale(${(s + 1) / 2 * 1.12}) rotate(${dx > 0 ? -5 : 5}deg)`,
        boxShadow: '0 16px 24px var(--saddle-soft)',
      },
      { transform: 'none', boxShadow: '0 3px 0 var(--saddle-deep)', ...(target ? {} : { opacity: 0 }) },
    ],
    { duration: FLY_MS, delay, easing: 'cubic-bezier(.25,.8,.25,1)', fill: 'backwards' },
  );
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    el.remove();
    if (target) {
      target.style.visibility = '';
      if (markChanged) mark(target);
    }
  };
  anim.finished.then(done, done);
  window.setTimeout(done, delay + FLY_MS + 400); // safety net: never leave a card hidden
}

/** A lingering glow on a card that just changed, so players can see what was replaced. */
function mark(el: HTMLElement) {
  el.removeAttribute('data-changed');
  void el.offsetWidth; // restart the CSS animation
  el.setAttribute('data-changed', '');
  window.setTimeout(() => el.removeAttribute('data-changed'), CHANGED_MS);
}

/** Wiggle a card (someone peeked at it); if `card` is given, show its face briefly (wrong snap). */
function flash(spot: Spot, card?: Card) {
  const el = cardEl(spot);
  if (!el || document.hidden) return;
  el.removeAttribute('data-flash');
  void el.offsetWidth;
  el.setAttribute('data-flash', '');
  window.setTimeout(() => el.removeAttribute('data-flash'), 1000);
  if (!card) return;
  const r = el.getBoundingClientRect();
  const size = el.className.match(/pcard--(sm|md|lg)/)?.[1] ?? 'md';
  const face = buildCard(card, size, r.width);
  Object.assign(face.style, {
    position: 'fixed',
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    margin: '0',
    zIndex: '49',
    pointerEvents: 'none',
  });
  layer().appendChild(face);
  const anim = face.animate(
    [
      { transform: 'rotateY(90deg)', offset: 0 },
      { transform: 'rotateY(0deg)', offset: 0.12 },
      { transform: 'rotateY(0deg)', offset: 0.88 },
      { transform: 'rotateY(90deg)', offset: 1 },
    ],
    { duration: reducedMotion() ? 1600 : 1800, easing: 'ease-in-out' },
  );
  anim.finished.then(() => face.remove(), () => face.remove());
  window.setTimeout(() => face.remove(), 2400);
}

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

const SUIT: Record<string, string> = { S: '♠', C: '♣', H: '♥', D: '♦' };

/** Same markup as <PlayingCard>, built by hand for the animation layer. */
function buildCard(card: Card | undefined, size: string, width: number): HTMLElement {
  const el = document.createElement('div');
  el.style.setProperty('--w', `${width}px`);
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
