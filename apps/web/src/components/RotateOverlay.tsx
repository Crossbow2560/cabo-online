import { createPortal } from 'react-dom';
import { useMediaQuery } from '../lib/useMediaQuery';

/** Covers every screen on a phone held upright: the game is played sideways, so players turn their
 * phone on the main page, before they ever reach the table. */
export function RotateOverlay() {
  const portraitPhone = useMediaQuery('(orientation: portrait) and (max-width: 640px) and (pointer: coarse)');
  // Android browsers can turn the screen for us, but only in full screen (and only after a tap).
  const canLock = !!document.documentElement.requestFullscreen && 'orientation' in screen && 'lock' in (screen.orientation as object);
  const goLandscape = async () => {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      await (screen.orientation as ScreenOrientation & { lock(o: string): Promise<void> }).lock('landscape');
    } catch {
      /* not allowed here: turning the phone by hand still works */
    }
  };
  if (!portraitPhone) return null;
  // Rendered on <body>, not inside #root (its own stacking layer), so it covers the card animations
  // that lib/motion.ts also puts on <body>.
  return createPortal(
    <div className="rotate-overlay" role="alertdialog" aria-labelledby="rotate-title" aria-describedby="rotate-text">
      <div className="rotate-overlay__phone" aria-hidden />
      <h2 id="rotate-title" className="heading rotate-overlay__title">Turn your phone sideways</h2>
      <p id="rotate-text" className="rotate-overlay__text">Cabo is played sideways. Turn your phone to carry on.</p>
      {canLock && (
        <button className="btn btn--primary" onClick={goLandscape}>
          Go full screen
        </button>
      )}
    </div>,
    document.body,
  );
}
