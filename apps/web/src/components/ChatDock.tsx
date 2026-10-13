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

/** Collapsible room chat: messages, one-tap quick chats, and a text box. */
export function ChatDock({ chat, me, open, onToggle, onSend, muted, onMute, className = '' }: {
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
}) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await onSend({ text })) setDraft('');
  };

  return (
    <div className={`dock dock--right ${className}`}>
      {open && (
        <div className="panel mini-card chat-card" id="chat-card">
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
                <span className="chat-line__name">
                  {m.fromName}
                  {m.fromId === me && <span className="chat-line__tag">(you)</span>}
                  {m.spectator && <span className="chat-line__tag">watching</span>}
                </span>
                <span className={`chat-line__text ${m.quick ? 'chat-line__text--quick' : ''}`}>{m.text}</span>
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
              <button key={q.id} className="chat-quick__btn" onClick={() => onSend({ quick: q.id })}>
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
            <input
              ref={inputRef}
              className="input chat-form__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // typing must never reach table or menu key handlers
                if (e.key === 'Escape') inputRef.current?.blur();
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
        onClick={onToggle}
      >
        Chat{unread > 0 && <span className="chip__badge" aria-hidden>{unread > 9 ? '9+' : unread}</span>} {open ? '▾' : '▴'}
      </button>
    </div>
  );
}

/** Recent chat per sender, for speech bubbles on the table: sessionId → text. */
export function chatBubbles(chat: ChatLine[], now: number, ms = 3500): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of chat) if (now - m.rx < ms) out.set(m.fromId, m.text.length > 40 ? `${m.text.slice(0, 39)}…` : m.text);
  return out;
}
