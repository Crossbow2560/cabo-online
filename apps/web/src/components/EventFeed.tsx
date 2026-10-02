import { useEffect, useRef } from 'react';
import type { LogLine } from '../App';

const TOAST_MS = 3500;

/** Recent events as toasts (top of the felt). */
export function Toasts({ log, now }: { log: LogLine[]; now: number }) {
  const recent = log.filter((l) => now - l.rx < TOAST_MS).slice(-3);
  return (
    <div className="toasts" aria-live="polite">
      {recent.map((l) => (
        <div key={l.id} className={`toast ${l.to ? 'toast--private' : ''}`}>
          {l.to && <span className="toast__tag">just you</span>}
          {l.text}
        </div>
      ))}
    </div>
  );
}

/** Collapsible full log in the bottom-right corner. */
export function LogDock({ log, open, onToggle }: {
  log: LogLine[];
  /** Open state lives in Game, so on phones opening this closes the Posse card. */
  open: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [open, log.length]);
  return (
    <div className="dock dock--right">
      {open && (
        <div className="panel mini-card log-card" id="log-card">
          <div className="mini-card__head">
            <span>Trail log</span>
          </div>
          <ol className="log-list" ref={ref}>
            {log.map((l) => (
              <li key={l.id} className={l.to ? 'log-list__private' : ''}>
                <time>{new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> {l.to ? '(you) ' : ''}
                {l.text}
              </li>
            ))}
          </ol>
        </div>
      )}
      <button className="btn btn--cream btn--sm chip" aria-expanded={open} aria-controls="log-card" onClick={onToggle}>
        Log {open ? '▾' : '▴'}
      </button>
    </div>
  );
}
