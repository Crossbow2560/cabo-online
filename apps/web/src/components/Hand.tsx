import type { Card, SlotView } from '@cabo/engine';
import { PlayingCard, slotPosition, type CardSize } from './PlayingCard';

export interface SlotState {
  card: Card | null;
  selectable: boolean;
  selected: boolean;
  flipped: boolean;
}

/** A player's cards in their square formation (plus extra columns for penalty cards). */
export function Hand({ slots, size, state, onCard, showLabels = false, ownerName, ownerId }: {
  slots: (SlotView | null)[];
  size: CardSize;
  state: (slot: number) => SlotState;
  onCard: (slot: number) => void;
  showLabels?: boolean;
  ownerName: string;
  ownerId: string;
}) {
  return (
    <div className={`hand hand--${size}`}>
      {slots.map((s, i) => {
        const st = state(i);
        return (
          <div key={i} style={slotPosition(i)}>
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
            />
          </div>
        );
      })}
    </div>
  );
}
