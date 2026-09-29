import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Title } from '../components/Title';

type Page = 'menu' | 'join' | 'watch';

/** Where the code page leads: sit down at the table, or just watch. */
const CODE_PAGE = {
  join: { title: 'Join Room', action: 'Join', hint: 'Ask the host for their six-character code.' },
  watch: { title: 'Spectate', action: 'Watch', hint: 'Follow a game without taking a seat — even one already under way.' },
} as const;

export function Rooms({ nickname, initialCode, onCreate, onJoin, onSpectate, onChangeName, onBack }: {
  nickname: string;
  initialCode: string;
  onCreate: () => void;
  onJoin: (code: string) => void;
  /** Watch the room without taking a seat. */
  onSpectate: (code: string) => void;
  onChangeName: () => void;
  onBack: () => void;
}) {
  // An invite link (?room=CODE) opens straight onto the join page with the code filled in.
  const [page, setPage] = useState<Page>(initialCode ? 'join' : 'menu');
  const [code, setCode] = useState(initialCode);

  if (page !== 'menu') {
    const p = CODE_PAGE[page];
    return (
      <main className="screen">
        <button className="btn btn--cream btn--sm back-btn" onClick={() => setPage('menu')}>
          ← Back
        </button>
        <Title size="md" />
        <h2 className="greeting lobby__heading">
          <Icon name="law-star" className="lobby__star" />
          {p.title}
          <Icon name="law-star" className="lobby__star" />
        </h2>
        <form
          className="panel code-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length !== 6) return;
            if (page === 'join') onJoin(code);
            else onSpectate(code);
          }}
        >
          <label className="code-card__label" htmlFor="room-code">
            Room code
          </label>
          <input
            id="room-code"
            className="input code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            maxLength={6}
            placeholder="CODE"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
          />
          <button type="submit" className="btn btn--primary btn--lg code-card__go" disabled={code.length !== 6}>
            {p.action}
          </button>
          <p className="code-card__hint">{p.hint}</p>
        </form>
      </main>
    );
  }

  return (
    <main className="screen">
      <button className="btn btn--cream btn--sm back-btn" onClick={onBack}>
        ← Back
      </button>
      <Title size="md" />
      <h2 className="greeting">Howdy, {nickname}!</h2>
      <div className="tiles">
        <button className="btn btn--primary tile" onClick={onCreate}>
          <Icon name="saloon" className="tile__icon" />
          <span className="tile__label">Create room</span>
          <span>Deal a new game &amp; invite friends</span>
        </button>
        <button className="btn btn--light tile" onClick={() => setPage('join')}>
          <Icon name="saloon-doors" className="tile__icon" />
          <span className="tile__label">Join room</span>
          <span>Got a code? Mosey on in.</span>
        </button>
        <button className="btn btn--cream tile" onClick={() => setPage('watch')}>
          <Icon name="binoculars" className="tile__icon" />
          <span className="tile__label">Spectate</span>
          <span>Watch a game from the rail</span>
        </button>
      </div>
      <button className="link" onClick={onChangeName} style={{ color: 'var(--cream)', textShadow: '0 1px 0 var(--saddle-deep)' }}>
        Not {nickname}? Change name
      </button>
    </main>
  );
}
