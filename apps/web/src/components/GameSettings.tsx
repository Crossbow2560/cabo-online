import { useEffect, useRef, useState } from 'react';
import { SETTING_LIMITS, type GameSettings } from '@cabo/engine';

const secs = (ms: number) => `${ms / 1000}s`;

const TIMERS: { key: 'peekMs' | 'turnMs' | 'choiceMs' | 'snapMs'; label: string; hint: string }[] = [
  { key: 'turnMs', label: 'Think time', hint: 'A whole turn: draw, then keep or discard' },
  { key: 'snapMs', label: 'Snap time', hint: 'How long a snap window stays open' },
  { key: 'choiceMs', label: 'Special card time', hint: 'Using a 7-K power, or giving a card after a snap' },
  { key: 'peekMs', label: 'Memorise time', hint: 'Looking at your two cards at the start of a round' },
];

/** Lobby ⚙ (host only, beside Start game): points limit and timers. */
export function GameSettingsDialog({ settings, canEdit, onSave, onClose }: {
  settings: GameSettings;
  canEdit: boolean;
  onSave: (next: GameSettings) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(settings);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const set = (patch: Partial<GameSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const limitOn = draft.maxPoints !== null;
  const pts = SETTING_LIMITS.maxPoints;
  const changed = JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <dialog ref={ref} className="modal modal--small" aria-labelledby="settings-title" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <form
        className="panel game-settings"
        onSubmit={(e) => {
          e.preventDefault();
          if (canEdit && changed) onSave(draft);
          onClose();
        }}
      >
        <h2 id="settings-title" className="heading game-settings__title">Game settings</h2>
        {!canEdit && <p className="game-settings__note">Only the host can change these.</p>}

        <fieldset className="game-settings__group" disabled={!canEdit}>
          <legend>Points limit</legend>
          <label className="game-settings__toggle">
            <input
              type="checkbox"
              checked={limitOn}
              onChange={(e) => set({ maxPoints: e.target.checked ? settings.maxPoints ?? 100 : null })}
            />
            <span>A player who reaches the limit loses, and the game ends</span>
          </label>
          <label className={`game-settings__row ${limitOn ? '' : 'game-settings__row--off'}`}>
            <span className="game-settings__label">
              Max points
              <small>Checked at the end of each round</small>
            </span>
            <input
              type="range"
              min={pts.min}
              max={pts.max}
              step={pts.step}
              value={draft.maxPoints ?? 100}
              disabled={!canEdit || !limitOn}
              onChange={(e) => set({ maxPoints: Number(e.target.value) })}
              aria-label="Max points"
            />
            <span className="game-settings__value">{limitOn ? draft.maxPoints : 'Off'}</span>
          </label>
        </fieldset>

        <fieldset className="game-settings__group" disabled={!canEdit}>
          <legend>Timers</legend>
          {TIMERS.map(({ key, label, hint }) => {
            const l = SETTING_LIMITS[key];
            return (
              <label key={key} className="game-settings__row">
                <span className="game-settings__label">
                  {label}
                  <small>{hint}</small>
                </span>
                <input
                  type="range"
                  min={l.min}
                  max={l.max}
                  step={l.step}
                  value={draft[key]}
                  onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<GameSettings>)}
                  aria-label={label}
                />
                <span className="game-settings__value">{secs(draft[key])}</span>
              </label>
            );
          })}
        </fieldset>

        <div className="confirm__actions">
          {canEdit ? (
            <>
              <button type="button" className="btn btn--light" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn--primary" disabled={!changed}>Save</button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={onClose} autoFocus>OK</button>
          )}
        </div>
      </form>
    </dialog>
  );
}
