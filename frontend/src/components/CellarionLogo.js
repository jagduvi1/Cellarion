import { useId } from 'react';

function CellarionLogo({ size = 36, color = 'currentColor', showText = false }) {
  const rawId = useId();
  const maskId = 'cm' + rawId.replace(/[^a-zA-Z0-9]/g, '');

  const iconHeight = 190;
  const totalHeight = showText ? 250 : iconHeight;

  return (
    <svg
      width={size}
      height={showText ? Math.round(size * (totalHeight / 200)) : size}
      viewBox={`0 0 200 ${totalHeight}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block' }}
      aria-label="Cellarion"
    >
      <defs>
        {/* Mask to cut crescent-moon swirl into the wine glass bowl */}
        <mask id={maskId}>
          <rect fill="white" x="0" y="0" width="200" height={iconHeight} />
          {/* Large circle → black hole in bowl */}
          <circle cx="106" cy="60" r="23" fill="black" />
          {/* Smaller offset circle → fills back part of hole → leaves crescent */}
          <circle cx="116" cy="54" r="19" fill="white" />
        </mask>
      </defs>

      {/* ── Arch ring (outer arch minus inner arch = vault frame) ── */}
      <path
        fill={color}
        fillRule="evenodd"
        d={[
          // Outer arch: center (100, 92), r=88
          'M 12,182 L 12,92 A 88,88 0 0,1 188,92 L 188,182 Z',
          // Inner arch: center (100, 94), r=76  → punched out by evenodd
          'M 24,182 L 24,94 A 76,76 0 0,1 176,94 L 176,182 Z',
        ].join(' ')}
      />

      {/* ── Wine glass bowl (crescent swirl masked out) ── */}
      <path
        fill={color}
        mask={`url(#${maskId})`}
        d="M 67,30 Q 100,21 133,30 L 109,90 L 91,90 Z"
      />

      {/* ── Wine glass stem ── */}
      <rect fill={color} x="94" y="90" width="12" height="34" rx="4" />

      {/* ── Wine glass base ── */}
      <path fill={color} d="M 80,124 L 120,124 L 116,133 L 84,133 Z" />

      {/* ── Left bottle rack — 5 rows, necks pointing outward (left) ── */}
      {[0, 1, 2, 3, 4].map((i) => {
        const y = 94 + i * 15;
        return (
          <g key={`lb-${i}`} fill={color}>
            {/* Bottle body */}
            <rect x="32" y={y - 3.5} width="30" height="7" rx="3.5" />
            {/* Bottle neck (narrower, pointing left) */}
            <rect x="26" y={y - 2} width="8" height="4" rx="2" />
          </g>
        );
      })}

      {/* ── Right bottle rack — 5 rows, necks pointing outward (right) ── */}
      {[0, 1, 2, 3, 4].map((i) => {
        const y = 94 + i * 15;
        return (
          <g key={`rb-${i}`} fill={color}>
            {/* Bottle body */}
            <rect x="138" y={y - 3.5} width="30" height="7" rx="3.5" />
            {/* Bottle neck (pointing right) */}
            <rect x="166" y={y - 2} width="8" height="4" rx="2" />
          </g>
        );
      })}

      {/* ── Optional brand name text ── */}
      {showText && (
        <text
          x="100"
          y="232"
          textAnchor="middle"
          fontFamily="Georgia, 'Times New Roman', serif"
          fontSize="30"
          fontWeight="bold"
          letterSpacing="5"
          fill="#C8A87E"
        >
          CELLARION
        </text>
      )}
    </svg>
  );
}

export default CellarionLogo;
