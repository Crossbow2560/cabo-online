import { useEffect, useRef, useState } from 'react';
import { CHAT_MAX_LEN, QUICK_CHATS, type QuickChatId } from '@cabo/engine';
import type { ChatLine } from '../App';

export type ChatSend = (req: { text: string } | { quick: QuickChatId }) => Promise<boolean>;

/** What App hands Lobby and Game; each adds `open` / `onToggle`. */
export interface ChatProps {
  chat: ChatLine[];
  me: string;
  onSend: ChatSend;
  muted: Map<string, string>;
  onMute: (id: string, name: string | null) => void;
}

const POPUP_MS = 4500;
const POPUP_OUT_MS = 300;

/** Collapsible room chat: messages, one-tap quick chats, and a text box. */
export function ChatDock({ chat, me, open, onToggle, onSend, muted, onMute, className = '', pill = false }: {
  chat: ChatLine[];
  me: string;
  /** Open state lives with the parent, so on phones the table can close the other docks. */
  open: boolean;
  onToggle: () => void;
  onSend: ChatSend;
  /** sessionId → name of people this viewer has muted (their messages are already filtered out). */
  muted: Map<string, string>;
  onMute: (id: string, name: string | null) => void;
  className?: string;
  /** Popups as a one-line pill in the bottom bar, left of the chip (where the corner above isn't free). */
  pill?: boolean;
}) {
  const [draft, setDraft] = useState('');
  // Phones: quick chats take the message list's place while picking (the toggle is hidden elsewhere).
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!open) setPicking(false);
  }, [open]);
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;

  // Open: a press anywhere outside the chat (or Escape) closes it. The Chat chip is inside, so it
  // still toggles on its own; a press on another chip closes this and opens that one.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) toggleRef.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && toggleRef.current();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Closed: "/" opens the chat (unless you're typing somewhere, or a dialog is up).
  useEffect(() => {
    if (open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
      e.preventDefault(); // or the "/" lands in the text box once it's focused
      toggleRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Unread: messages from others received since the panel was last open.
  const [seenRx, setSeenRx] = useState(() => Date.now());
  const last = chat.at(-1)?.rx ?? 0;
  useEffect(() => {
    if (open) setSeenRx(Math.max(Date.now(), last));
  }, [open, last]);
  const unread = open ? 0 : chat.filter((m) => m.rx > seenRx && m.fromId !== me).length;

  useEffect(() => {
    if (open) listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [open, chat.length]);

  // With a mouse, opening the chat puts the cursor straight in the text box (so does ✕ out of the
  // quick-chat picker). Not on touch screens: focusing would pop the on-screen keyboard over the table.
  const focusInput = () => {
    if (!window.matchMedia?.('(pointer: coarse)').matches) inputRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (open) focusInput();
  }, [open]);

  // Closed: other people's new messages pop up briefly above the Chat chip. Their own timer, so
  // they leave on time wherever the dock is (the lobby re-renders far less often than the table).
  const [now, setNow] = useState(() => Date.now());
  // Only what arrived since the panel was last open (not what you just read), newest two.
  const popups = open ? [] : chat.filter((m) => m.fromId !== me && m.rx > seenRx && now - m.rx < POPUP_MS).slice(-2);
  useEffect(() => {
    // Re-render when the next popup starts leaving, or is gone.
    const t0 = Date.now();
    const times = popups.flatMap((m) => [m.rx + POPUP_MS - POPUP_OUT_MS, m.rx + POPUP_MS]).filter((t) => t > t0);
    if (!times.length) return;
    const t = window.setTimeout(() => setNow(Date.now()), Math.min(...times) - t0 + 5);
    return () => window.clearTimeout(t);
  });
  useEffect(() => setNow(Date.now()), [chat.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await onSend({ text })) setDraft('');
  };

  return (
    <div className={`dock dock--right ${className}`} ref={rootRef}>
      {popups.length > 0 && (
        <div className={`chat-popups ${pill ? 'chat-popups--pill' : ''}`} role="status" aria-live="polite">
          {popups.map((m) => (
            <button
              key={m.id}
              className={`chat-popup ${now - m.rx > POPUP_MS - POPUP_OUT_MS ? 'chat-popup--out' : ''}`}
              onClick={onToggle}
              title="Open chat"
            >
              <span className="chat-popup__name">{m.fromName}</span>
              <span className={`chat-popup__text ${m.quick ? 'chat-popup__text--quick' : ''}`}>{m.text}</span>
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className={`panel mini-card chat-card ${picking ? 'chat-card--picking' : ''}`} id="chat-card">
          <div className="mini-card__head">
            <span>Chat</span>
            <span className="mini-card__sub">This room</span>
          </div>
          {muted.size > 0 && (
            <div className="chat-muted">
              Muted:{' '}
              {[...muted].map(([id, name]) => (
                <button key={id} className="chat-muted__item" onClick={() => onMute(id, null)} title={`Unmute ${name}`}>
                  {name} ✕
                </button>
              ))}
            </div>
          )}
          <ol className="chat-list" ref={listRef} aria-live="polite">
            {chat.length === 0 && <li className="chat-list__empty">No messages yet. Say howdy!</li>}
            {chat.map((m) => (
              <li key={m.id} className={`chat-line ${m.fromId === me ? 'chat-line--me' : ''}`}>
                <span className="chat-line__msg">
                  <span className="chat-line__name">
                    {m.fromName}
                    {m.fromId === me && <span className="chat-line__tag">(you)</span>}
                    {m.spectator && <span className="chat-line__tag">watching</span>}
                  </span>{' '}
                  <span className={m.quick ? 'chat-line__text--quick' : ''}>{m.text}</span>
                </span>
                {m.fromId !== me && (
                  <button className="chat-line__mute" onClick={() => onMute(m.fromId, m.fromName)} aria-label={`Mute ${m.fromName}`} title={`Mute ${m.fromName}`}>
                    🔇
                  </button>
                )}
              </li>
            ))}
          </ol>
          <div className="chat-quick" role="group" aria-label="Quick chat">
            {QUICK_CHATS.map((q) => (
              <button
                key={q.id}
                className="chat-quick__btn"
                onClick={() => {
                  setPicking(false);
                  onSend({ quick: q.id });
                }}
              >
                {q.text}
              </button>
            ))}
          </div>
          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <button
              type="button"
              className="chat-form__quick"
              onClick={() => {
                if (picking) focusInput();
                setPicking(!picking);
              }}
              aria-pressed={picking}
              aria-label={picking ? 'Back to messages' : 'Quick chats'}
              title={picking ? 'Back to messages' : 'Quick chats'}
            >
              {picking ? '✕' : '🤠'}
            </button>
            <input
              ref={inputRef}
              className="input chat-form__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // typing must never reach table or menu key handlers
                if (e.key === 'Escape') onToggle();
              }}
              maxLength={CHAT_MAX_LEN}
              placeholder="Say something…"
              aria-label="Chat message"
              enterKeyHint="send"
              autoComplete="off"
            />
            <button className="btn btn--primary btn--sm" type="submit" disabled={!draft.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
      <button
        className="btn btn--cream btn--sm chip"
        aria-expanded={open}
        aria-controls="chat-card"
        aria-label={unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
        aria-keyshortcuts="/"
        title="Chat (/)"
        onClick={onToggle}
      >
        Chat{unread > 0 && <span className="chip__badge" aria-hidden>{unread > 9 ? '9+' : unread}</span>} {open ? '▾' : '▴'}
      </button>
    </div>
  );
}
