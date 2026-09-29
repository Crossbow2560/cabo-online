import { useEffect, useRef, useState } from 'react';
import { BOT_LEVELS, MAX_PLAYERS, MIN_PLAYERS, type BotLevel, type GameSettings, type RoomState } from '@cabo/engine';
import { CopyField } from '../components/CopyField';
import { FinalResults } from '../components/FinalResults';
import { SoundControl } from '../components/SoundControl';
import { GameSettingsDialog } from '../components/GameSettings';
import { useMusic } from '../lib/sound';
import { Icon } from '../components/Icon';
import { Title } from '../components/Title';
import { usePublicUrl } from '../lib/config';
import { formatCountdown, useNow } from '../lib/useNow';

const MIN_ROWS = 3;

const LEVEL_INFO: Record<BotLevel, { label: string; hint: string }> = {
  beginner: { label: 'Beginner', hint: "Slow · First time eh'?" },
  novice: { label: 'Novice', hint: 'Unhurried · Calm and poised' },
  intermediate: { label: 'Intermediate', hint: "Steady · Steady hands pardner'" },
  expert: { label: 'Expert', hint: "Quick · You ain't leavin' the table"},
};

export function Lobby({ room, me, onStart, onLeave, onAddBot, onRemoveBot, onSettings, watching = false }: {
  room: RoomState;
  me: string;
  onStart: () => void;
  onLeave: () => void;
  onAddBot: (level: BotLevel) => void;
  onRemoveBot: (id: string) => void;
  /** Host: save the lobby ⚙ settings. */
  onSettings: (s: GameSettings) => void;
  /** Watching without a seat. */
  watching?: boolean;
}) {
  const now = useNow(1000);
  const isHost = room.hostId === me;
  const link = `${usePublicUrl()}/?room=${room.code}`;
  const enough = room.players.length >= MIN_PLAYERS;
  const emptyRows = Math.max(0, MIN_ROWS - room.players.length);
  // The level menu is placed against the screen (position: fixed), so the posse panel can keep
  // clipping its contents to its rounded border.
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const levelsOpen = menuAt !== null;
  const addBotRef = useRef<HTMLButtonElement>(null);
  const setLevelsOpen = (open: boolean) => {
    const r = open ? addBotRef.current?.getBoundingClientRect() : null;
    setMenuAt(r ? { top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) } : null);
  };
  // The room state is re-sent often; remember which game's standings were dismissed, not the object.
  const finalKey = room.final ? room.final.standings.map((s) => `${s.id}:${s.total}`).join(',') + `/${room.final.rounds}` : null;
  const [dismissedFinal, setDismissedFinal] = useState<string | null>(null);
  useMusic(); // music starts in the lobby and carries on at the table
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the level menu on an outside click or Escape.
  useEffect(() => {
    if (!levelsOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setLevelsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLevelsOpen(false);
    // A fixed menu would drift from its button: close it if the page moves.
    const onMove = () => setLevelsOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [levelsOpen]);

  return (
    <main className="screen screen--top">
      <div className="corner-controls">
        <SoundControl />
      </div>
      {settingsOpen && isHost && (
        <GameSettingsDialog settings={room.settings} canEdit onSave={onSettings} onClose={() => setSettingsOpen(false)} />
      )}
      {room.final && finalKey !== dismissedFinal && (
        <FinalResults final={room.final} me={me} onClose={() => setDismissedFinal(finalKey)} />
      )}
      <Title size="md" />

      <h2 className="greeting lobby__heading">
        <Icon name="law-star" className="lobby__star" />
        {isHost ? 'Create Room' : watching ? 'Watching' : 'Join Room'}
        <Icon name="law-star" className="lobby__star" />
      </h2>

      <section className="panel lobby__panel share" aria-label="Invite">
        <CopyField label="Invite link" value={link} variant="url" />
        <CopyField label="Room code" value={room.code} variant="code" />
      </section>

      <section className="panel lobby__panel posse" aria-label="Players">
        <div className="posse__head">
          <span className="posse__title">
            Posse <span className="posse__count">({room.players.length}/{MAX_PLAYERS})</span>
            {room.spectators.length > 0 && (
              <span className="posse__watchers" title={room.spectators.map((s) => s.name).join(', ')}>
                {' '}· 👁 {room.spectators.length}
              </span>
            )}
          </span>
          <div className="posse__actions">
            {isHost && (
              <div className="bot-menu" ref={menuRef}>
                <button
                  className="btn btn--light btn--sm"
                  ref={addBotRef}
                  onClick={() => setLevelsOpen(!levelsOpen)}
                  disabled={room.players.length >= MAX_PLAYERS}
                  aria-haspopup="menu"
                  aria-expanded={levelsOpen}
                >
                  + Add bot
                </button>
                {menuAt && (
                  <div className="panel bot-menu__list" role="menu" style={{ top: menuAt.top, right: menuAt.right }}>
                    {BOT_LEVELS.map((level) => (
                      <button
                        key={level}
                        role="menuitem"
                        className="bot-menu__item"
                        onClick={() => {
                          setLevelsOpen(false);
                          onAddBot(level);
                        }}
                      >
                        <span className="bot-menu__label">{LEVEL_INFO[level].label}</span>
                        <span className="bot-menu__hint">{LEVEL_INFO[level].hint}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button className="btn btn--primary btn--sm" onClick={onLeave}>
              {watching ? 'Stop watching' : 'Leave room'}
            </button>
          </div>
        </div>
        <div className="posse__scroll">
          <table className="posse__table">
            <thead>
              <tr className="posse__cols">
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col" className="posse__status-col">Status</th>
              </tr>
            </thead>
            <tbody>
              {room.players.map((p, i) => (
                <tr key={p.id}>
                  <td className="posse__seat">{i + 1}</td>
                  <td>
                    <span className="posse__name">{p.name}</span>
                    {p.id === room.hostId && (
                      <span className="host-tag">
                        <Icon name="law-star" className="host-tag__icon" />
                        Host
                      </span>
                    )}
                    {p.id === me && <span className="you-tag">(you)</span>}
                    {p.botLevel && <span className="bot-tag">{LEVEL_INFO[p.botLevel].label}</span>}
                  </td>
                  <td className="posse__status-col">
                    <span className={`status-dot ${p.connected ? 'status-dot--on' : ''}`} aria-hidden />
                    <span className="posse__status-text">{p.bot ? 'Bot' : p.connected ? 'Online' : 'Away'}</span>
                    {p.bot && isHost && (
                      <button className="posse__remove" onClick={() => onRemoveBot(p.id)} aria-label={`Remove ${p.name}`} title="Remove bot">
                        ✕
                      </button>
                    )}
                    {!p.connected && p.offlineSince !== null && (
                      <span className="away" title="Removed automatically if they don't come back">
                        {' '}· {formatCountdown(p.offlineSince + room.kickAfterMs - now)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {Array.from({ length: emptyRows }, (_, i) => (
                <tr key={`empty-${i}`} className="posse__empty">
                  <td className="posse__seat">{room.players.length + i + 1}</td>
                  <td colSpan={2}>Waiting for a partner…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="lobby__start stack">
        {isHost ? (
          <>
            {/* The host's game settings sit right beside Start. */}
            <div className="lobby__start-row">
              <button className="btn btn--primary btn--lg" onClick={onStart} disabled={!enough}>
                Start game
              </button>
              <button
                className="btn btn--light btn--lg lobby__settings-btn"
                onClick={() => setSettingsOpen(true)}
                aria-label="Game settings"
                title="Game settings"
              >
                <Icon name="cog" className="lobby__settings-icon" />
              </button>
            </div>
            {!enough && <p className="hint">Need at least {MIN_PLAYERS} players — share the link above</p>}
          </>
        ) : (
          <button className="btn btn--primary btn--lg" disabled>
            {watching ? 'Watching — waiting for the host…' : 'Waiting for the host…'}
          </button>
        )}
      </div>
    </main>
  );
}
