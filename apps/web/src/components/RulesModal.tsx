import { useEffect, useRef } from 'react';

/** Rules popup: native <dialog> (focus trap + Esc), blurred backdrop, closes on ✕ / Esc / backdrop click. */
export function RulesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="rules-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop area
      }}
    >
      <div className="panel modal__card">
        <button className="btn btn--primary modal__close" onClick={onClose} aria-label="Close rules">
          ✕
        </button>
        <div className="modal__head">
          <h2 id="rules-title" className="heading">How to play</h2>
        </div>
        <div className="modal__body">
          <h3>The goal</h3>
          <p>Finish with the <b>lowest total</b> of cards in front of you. Swap your cards for lower ones, or get rid of them by snapping matching ranks.</p>

          <h3>The deal</h3>
          <p>Everyone gets 4 cards face down in a square. At the start you may peek at your <b>two nearest cards</b> (the bottom row) once - memorise them! After that you can’t look at your cards unless a special card lets you.</p>

          <h3>Your turn - do one of</h3>
          <ul>
            <li><b>Draw from the stockpile</b>, then keep it (swap it with one of your cards, which goes to the discard) or discard it.</li>
            <li><b>Take the top discard</b> and swap it with one of your cards.</li>
            <li><b>Call CABO</b> - everyone else gets one more turn, then all cards are revealed.</li>
          </ul>

          <h3>Special cards</h3>
          <p>When you draw one of these and discard it straight away, you may use its power:</p>
          <ul>
            <li><span className="badge">7</span><span className="badge">8</span>Look at one of your own cards.</li>
            <li><span className="badge">9</span><span className="badge">10</span>Look at another player’s card.</li>
            <li><span className="badge">J</span><span className="badge">Q</span>Blind swap one of your cards with another player’s.</li>
            <li><span className="badge">K♠</span><span className="badge">K♣</span>Look at another player’s card and one of your own, then choose whether to swap them.</li>
          </ul>

          <h3>Snapping</h3>
          <p>Whenever a card is discarded, anyone can race to throw a card of the <b>same rank</b> on top — from their own hand or someone else’s. Only the first one counts.</p>
          <ul>
            <li>Snap your own card: you now have one fewer card.</li>
            <li>Snap an opponent’s card: you may move one of your cards into their gap.</li>
            <li>Wrong guess: the card goes back and you take a <b>penalty card</b>.</li>
          </ul>

          <h3>Scoring</h3>
          <table className="score-table">
            <tbody>
              <tr><td>Joker</td><td>−1</td></tr>
              <tr><td>Red King (K♥ K♦)</td><td>0</td></tr>
              <tr><td>Ace</td><td>1</td></tr>
              <tr><td>2 – 10</td><td>face value</td></tr>
              <tr><td>Jack</td><td>11</td></tr>
              <tr><td>Queen</td><td>12</td></tr>
              <tr><td>Black King (K♠ K♣)</td><td>13</td></tr>
            </tbody>
          </table>

          <p className="attribution">
            Icons by Delapouite &amp; Lorc — <a href="https://game-icons.net" target="_blank" rel="noreferrer">game-icons.net</a> (CC BY 3.0)
          </p>
        </div>
      </div>
    </dialog>
  );
}
