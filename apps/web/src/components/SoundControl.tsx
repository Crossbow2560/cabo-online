import { useEffect, useRef, useState } from 'react';
import { setSoundSettings, useSoundSettings, type SoundSettings } from '../lib/sound';
import { Icon } from './Icon';

const SLIDERS: { key: 'master' | 'game' | 'music'; label: string; hint?: string }[] = [
  { key: 'master', label: 'Master' },
  { key: 'game', label: 'Game', hint: 'Cards, turns, CABO' },
  { key: 'music', label: 'Music', hint: 'Background tune' },
];

/** Speaker button in the table's top bar: opens master / game / music volumes and a mute toggle. */
export function SoundControl() {
  const s = useSoundSettings();
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const silent = s.muted || s.master === 0;

  // Close on an outside click, Escape, or if the page moves (the panel is fixed to the screen).
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [at]);

  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    setAt(at || !r ? null : { top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  };

  return (
    <>
      <button
        ref={btn}
        className="btn btn--light btn--sm tbar__icon"
        onClick={toggle}
        aria-label="Sound settings"
        aria-haspopup="dialog"
        aria-expanded={!!at}
        title={silent ? 'Sound is off' : 'Sound'}
      >
        <Icon name={silent ? 'speaker-off' : 'speaker'} className="tbar__svg" />
      </button>
      {at && (
        <div ref={panel} className="panel sound-panel" role="dialog" aria-label="Sound" style={{ top: at.top, right: at.right }}>
          <div className="sound-panel__head">
            <span className="sound-panel__title">Sound</span>
            <button className="btn btn--light btn--sm" onClick={() => setSoundSettings({ muted: !s.muted })} aria-pressed={s.muted}>
              {s.muted ? 'Unmute' : 'Mute all'}
            </button>
          </div>
          {SLIDERS.map(({ key, label, hint }) => (
            <label key={key} className={`sound-row ${s.muted ? 'sound-row--off' : ''}`}>
              <span className="sound-row__label">
                {label}
                {hint && <small>{hint}</small>}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(s[key] * 100)}
                onChange={(e) => setSoundSettings({ [key]: Number(e.target.value) / 100 } as Partial<SoundSettings>)}
                aria-label={`${label} volume`}
              />
              <span className="sound-row__value">{Math.round(s[key] * 100)}</span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}
