import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Title } from '../components/Title';

export function Rooms({ nickname, initialCode, onCreate, onJoin, onChangeName, onBack }: {
  nickname: string;
  initialCode: string;
  onCreate: () => void;
  onJoin: (code: string) => void;
  onChangeName: () => void;
  onBack: () => void;
}) {
  const [joining, setJoining] = useState(initialCode.length > 0);
  const [code, setCode] = useState(initialCode);

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

        {joining ? (
          <form
            className="btn btn--light tile tile--static"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 6) onJoin(code);
            }}
          >
            <Icon name="saloon-doors" className="tile__icon" />
            <div className="join-form">
              <input
                className="input code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                maxLength={6}
                placeholder="CODE"
                aria-label="Room code"
                autoFocus
              />
              <button type="submit" className="btn btn--primary" disabled={code.length !== 6}>
                Join
              </button>
            </div>
          </form>
        ) : (
          <button className="btn btn--light tile" onClick={() => setJoining(true)}>
            <Icon name="saloon-doors" className="tile__icon" />
            <span className="tile__label">Join room</span>
            <span>Got a code? Mosey on in.</span>
          </button>
        )}
      </div>
      <button className="link" onClick={onChangeName} style={{ color: 'var(--cream)', textShadow: '0 1px 0 var(--saddle-deep)' }}>
        Not {nickname}? Change name
      </button>
    </main>
  );
}
