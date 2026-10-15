import { useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

type Target = { id: string; name: string; bot: boolean; spectator: boolean };

/**
 * Host's "remove from room": always asks first. Returns `ask` for the ✕ buttons and the dialog
 * to render once.
 */
export function useKickConfirm(onKick: (id: string) => void, midRound: boolean) {
  const [target, setTarget] = useState<Target | null>(null);
  const ask = (id: string, name: string, { bot = false, spectator = false } = {}) => setTarget({ id, name, bot, spectator });
  // Keep showing the last target while the dialog closes, so its text doesn't blank out.
  const shown = useRef<Target | null>(null);
  if (target) shown.current = target;
  const t = shown.current;

  const dialog = (
    <ConfirmDialog
      open={target !== null}
      title={`Remove ${t?.name ?? ''}?`}
      confirmLabel="Remove"
      cancelLabel="Cancel"
      onCancel={() => setTarget(null)}
      onConfirm={() => {
        if (target) onKick(target.id);
        setTarget(null);
      }}
    >
      <p>
        {t?.spectator
          ? "They'll stop watching and can't come back to this room."
          : t?.bot
            ? midRound
              ? 'Their cards leave the table and they forfeit this round. You can add another bot between rounds.'
              : 'The bot leaves the posse. You can add another one any time before the deal.'
            : midRound
              ? "Their cards leave the table and they forfeit this round. They can't rejoin this room."
              : "They'll be taken out of the room and can't rejoin it."}
      </p>
    </ConfirmDialog>
  );
  return { ask, dialog };
}
