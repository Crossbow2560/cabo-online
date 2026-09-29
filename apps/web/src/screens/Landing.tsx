import { Title } from '../components/Title';

export function Landing({ onPlay, onRules }: { onPlay: () => void; onRules: () => void }) {
  return (
    <main className="screen">
      <Title />
      <p className="tagline">The lowest hand wins, partner.</p>
      <div className="stack" style={{ marginTop: 16 }}>
        <button className="btn btn--primary btn--lg" onClick={onPlay} autoFocus>
          Play now
        </button>
        <button className="btn btn--light btn--lg" onClick={onRules}>
          View rules
        </button>
      </div>
      <footer className="footer">
        Icons by Delapouite, Lorc &amp; Guard13007 - <a href="https://game-icons.net" target="_blank" rel="noreferrer">game-icons.net</a> (CC BY 3.0)
      </footer>
    </main>
  );
}
