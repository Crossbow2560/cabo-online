import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/copy';

export function CopyField({ label, value, variant }: { label: string; value: string; variant: 'url' | 'code' }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    if (!ok) inputRef.current?.select();
  };

  return (
    <div className="copy-field">
      <span className="copy-field__label">{label}</span>
      <div className="copy-field__row">
        <input
          ref={inputRef}
          className={`copy-field__value copy-field__value--${variant}`}
          value={value}
          readOnly
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button className="btn btn--light btn--sm copy-field__btn" onClick={copy}>
          {state === 'copied' ? 'Copied!' : state === 'failed' ? 'Press Ctrl+C' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
