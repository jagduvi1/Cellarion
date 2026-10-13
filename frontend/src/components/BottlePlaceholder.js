import { swatchType } from '../utils/wineColour';
import './BottlePlaceholder.css';

/**
 * A drawn bottle for a wine nobody has photographed yet: glass in the wine's
 * colour and a paper label with the producer, the wine's name and the
 * vintage (beta feedback 2026-10-12: a flat colour block "always looks a bit
 * weird"). Drawn, never fetched — a picture looked up on the web would be
 * someone else's photo of perhaps another wine, and would tell the image
 * host which wines the member keeps.
 *
 * `compact`: no text, for a thumbnail too small to read it.
 *
 * The bottle is a little stouter than a real one so its label has room for
 * readable text (viewBox units ≈ CSS px at the sizes it is shown).
 */

const VIEW_W = 120;
const VIEW_H = 260;
const LABEL = { x: 24, y: 128, w: 72, h: 104 };
const TEXT_W = LABEL.w - 8;
const CHAR_EM = 0.56; // average serif glyph width per font size
const NAME_SIZES = [12, 10.5, 9, 7.8];
const NAME_MAX_LINES = 4;
const PRODUCER_SIZE = 6.5;
const VINTAGE_SIZE = 9;

const charsAt = (size) => Math.max(4, Math.floor(TEXT_W / (size * CHAR_EM)));

/** Word-wrap `text` into lines of at most `maxChars`; a word longer than that is cut with "…". */
export function wrapWords(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w0 of words) {
    const w = w0.length > maxChars ? `${w0.slice(0, Math.max(1, maxChars - 1))}…` : w0;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line += ` ${w}`;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The name's lines and font size: the largest size at which every word fits
 * whole and the name takes at most NAME_MAX_LINES; failing that the smallest
 * size, words cut and the last line ending in "…".
 */
export function fitName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const longest = words.reduce((m, w) => Math.max(m, w.length), 0);
  for (const size of NAME_SIZES) {
    if (longest > charsAt(size)) continue;
    const lines = wrapWords(name, charsAt(size));
    if (lines.length <= NAME_MAX_LINES) return { size, lines };
  }
  const size = NAME_SIZES[NAME_SIZES.length - 1];
  const all = wrapWords(name, charsAt(size));
  if (all.length <= NAME_MAX_LINES) return { size, lines: all };
  const lines = all.slice(0, NAME_MAX_LINES);
  const last = lines[NAME_MAX_LINES - 1];
  lines[NAME_MAX_LINES - 1] = `${last.slice(0, Math.max(1, charsAt(size) - 1))}…`;
  return { size, lines };
}

// Base at the bottom, capsule at the top.
const BOTTLE_PATH = 'M50,8 Q50,3 55,3 L65,3 Q70,3 70,8 L70,70 C70,90 104,94 104,118 L104,247 Q104,256 95,256 L25,256 Q16,256 16,247 L16,118 C16,94 50,90 50,70 Z';

export default function BottlePlaceholder({ wine, vintage, compact = false, className = '', title }) {
  const type = swatchType(wine, '') || 'red';
  const producer = (wine?.producer || '').trim();
  const name = (wine?.name || '').trim();
  const year = vintage && vintage !== 'Unknown' ? String(vintage) : '';
  const label = title || [producer, name, year].filter(Boolean).join(' ');

  const cx = VIEW_W / 2;
  const producerLines = wrapWords(producer.toUpperCase(), charsAt(PRODUCER_SIZE)).slice(0, 2);
  const producerTop = LABEL.y + 11;
  const producerGap = PRODUCER_SIZE + 1.4;
  const { size, lines } = fitName(name);
  const lineH = size * 1.18;
  // The name sits centred between the producer and the vintage.
  const areaTop = producerTop + (producerLines.length ? producerLines.length * producerGap : 0) + 2;
  const areaBottom = LABEL.y + LABEL.h - (year ? VINTAGE_SIZE + 8 : 6);
  const blockH = lines.length * lineH;
  const nameTop = areaTop + Math.max(0, (areaBottom - areaTop - blockH) / 2) + size * 0.85;

  return (
    <svg
      className={`bottle-placeholder bottle-placeholder--${type}${compact ? ' bottle-placeholder--compact' : ''}${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role={compact ? undefined : 'img'}
      aria-hidden={compact ? 'true' : undefined}
      aria-label={compact ? undefined : label}
      focusable="false"
    >
      <path className="bottle-placeholder__glass" d={BOTTLE_PATH} />
      {/* A highlight down the glass, so it reads as a bottle, not a shape. */}
      <path className="bottle-placeholder__shine" d="M27,124 L27,242" />
      <rect className="bottle-placeholder__capsule" x="49" y="3" width="22" height="40" rx="3" />
      <rect className="bottle-placeholder__label" x={LABEL.x} y={LABEL.y} width={LABEL.w} height={LABEL.h} rx="3" />
      {!compact && (
        <g className="bottle-placeholder__text" textAnchor="middle">
          {producerLines.map((l, i) => (
            <text key={`p${i}`} x={cx} y={producerTop + i * producerGap} fontSize={PRODUCER_SIZE} className="bottle-placeholder__producer">{l}</text>
          ))}
          {lines.map((l, i) => (
            <text key={`n${i}`} x={cx} y={nameTop + i * lineH} fontSize={size} className="bottle-placeholder__name">{l}</text>
          ))}
          {year && <text x={cx} y={LABEL.y + LABEL.h - 7} fontSize={VINTAGE_SIZE} className="bottle-placeholder__vintage">{year}</text>}
        </g>
      )}
    </svg>
  );
}
