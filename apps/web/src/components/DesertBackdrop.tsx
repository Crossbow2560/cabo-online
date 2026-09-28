/** Fixed desert-sunset scenery behind every screen. Palette colours only. */
export function DesertBackdrop() {
  return (
    <svg
      className="backdrop"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', zIndex: 0 }}
    >
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--cream)" />
          <stop offset="0.75" stopColor="var(--sand)" />
        </linearGradient>
        <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0.6" stopColor="var(--cream)" />
          <stop offset="1" stopColor="var(--cream)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="1440" height="900" fill="url(#sky)" />

      {/* sun with rays */}
      <g transform="translate(720 330)">
        <circle r="210" fill="url(#sun)" opacity="0.8" />
        <circle r="130" fill="var(--cream)" stroke="var(--sand)" strokeWidth="10" />
      </g>

      {/* far mesas */}
      <path
        fill="var(--leather)"
        opacity="0.75"
        d="M0 560 L90 560 L110 500 L260 500 L285 560 L420 560 L440 470 L470 455 L600 455 L625 470 L650 560
           L820 560 L840 520 L960 520 L985 560 L1150 560 L1175 480 L1330 480 L1355 560 L1440 560 L1440 900 L0 900 Z"
      />

      {/* mid buttes */}
      <path
        fill="var(--saddle)"
        opacity="0.85"
        d="M0 650 L150 650 L175 590 L200 580 L330 580 L355 590 L380 650 L700 650 L720 610 L800 610 L820 650
           L1000 650 L1030 560 L1060 545 L1210 545 L1240 560 L1270 650 L1440 650 L1440 900 L0 900 Z"
      />

      {/* foreground ground */}
      <path
        fill="var(--saddle-deep)"
        d="M0 760 C 240 720, 480 740, 720 750 S 1200 730, 1440 745 L1440 900 L0 900 Z"
      />

      {/* cacti */}
      <Saguaro x={140} y={760} scale={1.1} />
      <Saguaro x={1290} y={748} scale={1.35} flip />
      <Saguaro x={1370} y={752} scale={0.7} />
      {/* these two stay in frame on narrow (phone) crops */}
      <Saguaro x={560} y={752} scale={0.55} />
      <Saguaro x={880} y={750} scale={0.75} flip />
    </svg>
  );
}

function Saguaro({ x, y, scale = 1, flip = false }: { x: number; y: number; scale?: number; flip?: boolean }) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}
      stroke="var(--saddle-deep)"
      strokeWidth="26"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      <path d="M0 10 L0 -170" />
      <path d="M0 -70 L-40 -70 L-40 -120" />
      <path d="M0 -100 L36 -100 L36 -140" />
    </g>
  );
}
