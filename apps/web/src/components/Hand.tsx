import type { Card, SlotView } from '@cabo/engine';
import { PlayingCard, slotCoords, slotPosition, type CardSize, type Orient } from './PlayingCard';

export interface SlotState {
  card: Card | null;
  selectable: boolean;
  selected: boolean;
  flipped: boolean;
}

/** A player's cards in their square formation (plus extra columns for penalty cards). */
export function Hand({ slots, size, state, onCard, showLabels = false, ownerName, ownerId, orient = 'self' }: {
  slots: (SlotView | null)[];
  size: CardSize;
  state: (slot: number) => SlotState;
  onCard: (slot: number) => void;
  showLabels?: boolean;
  ownerName: string;
  ownerId: string;
  orient?: Orient;
}) {
  const maxC = slots.reduce((m, _, i) => Math.max(m, slotCoords(i).c), 1);
  return (
    <div className={`hand hand--${size}`}>
      {slots.map((s, i) => {
        const st = state(i);
        return (
          <div key={i} style={slotPosition(i, orient, maxC)}>
            <PlayingCard
              card={st.card}
              gap={s === null}
              size={size}
              selectable={st.selectable}
              selected={st.selected}
              flipped={st.flipped}
              label={showLabels ? `#${i + 1}` : undefined}
              onClick={() => onCard(i)}
              title={`${ownerName} — card #${i + 1}`}
              spot={`slot:${ownerId}:${i}`}
              flipDelay={i * 70}
            />
          </div>
        );
      })}
    </div>
  );
}
