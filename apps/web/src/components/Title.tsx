/** The big outlined CABO wordmark: outline copy underneath, gradient fill on top. */
export function Title({ size = 'lg' }: { size?: 'lg' | 'md' | 'sm' }) {
  return (
    <h1 className={`title ${size === 'lg' ? '' : `title--${size}`}`}>
      <span className="title__outline" aria-hidden>CABO</span>
      <span className="title__fill">CABO</span>
    </h1>
  );
}
