import { useState } from 'react';
import { Icon } from '../components/Icon';

export interface NewSession {
  sessionId: string;
  nickname: string;
  token: string;
}

export function Nickname({ onSession, onBack }: { onSession: (s: NewSession) => void; onBack: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: name }),
      });
      const body = await r.json();
      if (!r.ok) return setError(body.error ?? 'Something went wrong');
      onSession(body);
    } catch {
      setError("Can't reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen">
      <form className="panel stack" onSubmit={submit} style={{ marginTop: 48 }}>
        <Icon name="western-hat" className="panel__icon" />
        <h2 className="heading">Nickname</h2>
        <input
          className="input"
          value={name}
          maxLength={8}
          placeholder="What do folks call you?"
          onChange={(e) => setName(e.target.value)}
          autoFocus
          aria-label="Nickname"
        />
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn btn--primary" style={{ width: '100%' }} disabled={!name.trim() || busy}>
          Enter
        </button>
        <button type="button" className="link" onClick={onBack}>
          ← back
        </button>
      </form>
    </main>
  );
}
