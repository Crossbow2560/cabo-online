import { useLayoutEffect, useRef } from 'react';
import type { Card } from '@cabo/engine';
import { Icon } from './Icon';

const SUIT: Record<string, string> = { S: '♠', C: '♣', H: '♥', D: '♦' };

export type CardSize = 'sm' | 'md' | 'lg';

/** A playing card: face-up when `card` is set, the Cabo back otherwise, or a dashed gap. */
export function PlayingCard({
  card,
  gap = false,
  size = 'lg',
  selectable = false,
  selected = false,
  flipped = false,
  label,
  onClick,
  title,
  spot,
  flipDelay = 0,
}: {
  card: Card | null;
  gap?: boolean;
  size?: CardSize;
  selectable?: boolean;
  selected?: boolean;
  /** Just turned face-up by a peek — plays the flip animation. */
  flipped?: boolean;
  label?: string;
  onClick?: () => void;
  title?: string;
  /** Animation anchor, e.g. "slot:<playerId>:2", "stock", "discard", "held:<playerId>". */
  spot?: string;
  /** Stagger (ms) when many cards turn over at once, e.g. the round-end reveal. */
  flipDelay?: number;
}) {
  // Turn the card over (rather than swapping its face instantly) when it goes face-up <-> face-down in place.
  const ref = useRef<HTMLElement>(null);
  const wasFace = useRef<boolean | null>(null);
  const face = !gap && !!card;
  useLayoutEffect(() => {
    const prev = wasFace.current;
    wasFace.current = face;
    const el = ref.current;
    if (prev === null || prev === face || gap || !el || document.hidden) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    el.animate([{ transform: 'rotateY(90deg)' }, { transform: 'rotateY(0deg)' }], {
      duration: 320,
      delay: flipDelay,
      easing: 'ease-out',
      fill: 'backwards',
    });
  }, [face, gap, flipDelay]);

  const cls = [
    'pcard',
    `pcard--${size}`,
    gap ? 'pcard--gap' : card ? 'pcard--face' : 'pcard--back',
    card && (card.suit === 'H' || card.suit === 'D') ? 'pcard--red' : '',
    selectable ? 'pcard--selectable' : '',
    selected ? 'pcard--selected' : '',
    flipped ? 'pcard--flipped' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = gap ? null : card ? <Face card={card} /> : <Back />;
  const aria = gap ? 'empty slot' : card ? cardName(card) : 'face-down card';

  return (
    <div className="pcard-wrap">
      {onClick && !gap ? (
        <button type="button" ref={ref as React.RefObject<HTMLButtonElement>} className={cls} onClick={onClick} disabled={!selectable} aria-label={title ?? aria} title={title} data-spot={spot}>
          {content}
        </button>
      ) : (
        <div ref={ref as React.RefObject<HTMLDivElement>} className={cls} aria-label={aria} role="img" data-spot={spot}>
          {content}
        </div>
      )}
      {label && <span className="pcard__label">{label}</span>}
    </div>
  );
}

function Face({ card }: { card: Card }) {
  if (card.rank === 'JOKER') {
    return (
      <>
        <span className="pcard__corner">★</span>
        <span className="pcard__joker">
          <Icon name="law-star" className="pcard__joker-icon" />
          <span>JOKER</span>
        </span>
        <span className="pcard__corner pcard__corner--br">★</span>
      </>
    );
  }
  const suit = SUIT[card.suit!];
  return (
    <>
      <span className="pcard__corner">
        {card.rank}
        <br />
        {suit}
      </span>
      <span className="pcard__pip">{suit}</span>
      <span className="pcard__corner pcard__corner--br">
        {card.rank}
        <br />
        {suit}
      </span>
    </>
  );
}

function Back() {
  return (
    <span className="pcard__back">
      <Icon name="law-star" className="pcard__back-icon" />
    </span>
  );
}

function cardName(card: Card) {
  if (card.rank === 'JOKER') return 'Joker';
  const suits: Record<string, string> = { S: 'spades', C: 'clubs', H: 'hearts', D: 'diamonds' };
  return `${card.rank} of ${suits[card.suit!]}`;
}

/** Grid position for slot i: 0-1 top row, 2-3 bottom ("nearest") row, penalty cards in extra columns. */
export function slotPosition(i: number) {
  if (i < 4) return { gridRow: Math.floor(i / 2) + 1, gridColumn: (i % 2) + 1 };
  return { gridRow: (i % 2) + 1, gridColumn: 3 + Math.floor((i - 4) / 2) };
}
