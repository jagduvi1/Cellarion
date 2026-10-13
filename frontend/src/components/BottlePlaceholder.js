import { useId } from 'react';
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
const NAME_SIZES = [12, 10.5, 9, 7.8];
const NAME_MAX_LINES = 4;
const PRODUCER_SIZE = 6.5;
const PRODUCER_MAX_LINES = 2;
const VINTAGE_SIZE = 9;

// Text is measured by the width of its letters, not their number (release
// audit 2026-10-13: a name in capitals, or in Chinese, Japanese or Korean,
// ran off the label). Rough serif widths in ems: a CJK character is a full
// em, a capital about 0.72, anything else an average lower-case letter.
const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;
const CHAR_EM = 0.56;
const CAPITAL_EM = 0.72;
const SPACE_EM = 0.3;

export function glyphEm(ch) {
  if (CJK.test(ch)) return 1;
  if (ch === ' ') return SPACE_EM;
  return ch !== ch.toLowerCase() ? CAPITAL_EM : CHAR_EM;
}

/** The width of `text` in ems of its font size. */
export const textEm = (text) => [...String(text)].reduce((sum, ch) => sum + glyphEm(ch), 0);

const isCjk = (word) => CJK.test(word);

/**
 * A word too wide for a line, in pieces that fit: CJK between any two
 * characters (those names have no spaces at all), other scripts with a "-".
 */
function breakWord(word, maxEm) {
  const mark = isCjk(word) ? '' : '-';
  const room = maxEm - textEm(mark);
  const pieces = [];
  let piece = '';
  for (const ch of word) {
    if (piece && textEm(piece + ch) > room) { pieces.push(piece + mark); piece = ch; } else piece += ch;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** Word-wrap `text` into lines at most `maxEm` wide; a word wider than a line is broken across lines. */
export function wrapWords(text, maxEm) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const add = (w) => {
    if (!line) line = w;
    else if (textEm(`${line} ${w}`) <= maxEm) line += ` ${w}`;
    else { lines.push(line); line = w; }
  };
  for (const w of words) {
    if (textEm(w) <= maxEm) add(w);
    else breakWord(w, maxEm).forEach(add);
  }
  if (line) lines.push(line);
  return lines;
}

/** At most `max` lines, the last ending in "…" when text was left out. */
export function clampLines(lines, max, maxEm) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1].replace(/-$/, '');
  while (last && textEm(`${last}…`) > maxEm) last = [...last].slice(0, -1).join('');
  kept[max - 1] = `${last.trimEnd()}…`;
  return kept;
}

/**
 * The name's lines and font size: the largest size at which every word fits
 * whole (a CJK name may break anywhere) and the name takes at most
 * NAME_MAX_LINES; failing that the smallest size, long words broken and the
 * last line ending in "…".
 */
export function fitName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  for (const size of NAME_SIZES) {
    const maxEm = TEXT_W / size;
    if (!words.every((w) => isCjk(w) || textEm(w) <= maxEm)) continue;
    const lines = wrapWords(name, maxEm);
    if (lines.length <= NAME_MAX_LINES) return { size, lines };
  }
  const size = NAME_SIZES[NAME_SIZES.length - 1];
  const maxEm = TEXT_W / size;
  return { size, lines: clampLines(wrapWords(name, maxEm), NAME_MAX_LINES, maxEm) };
}

// Base at the bottom, capsule at the top.
const BOTTLE_PATH = 'M50,8 Q50,3 55,3 L65,3 Q70,3 70,8 L70,70 C70,90 104,94 104,118 L104,247 Q104,256 95,256 L25,256 Q16,256 16,247 L16,118 C16,94 50,90 50,70 Z';

export default function BottlePlaceholder({ wine, vintage, compact = false, className = '', title }) {
  // The label's text is clipped to the label: the measure above is an
  // estimate, and a font a little wider than it never spills onto the glass.
  const clipId = `bp-label-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const type = swatchType(wine, '') || 'red';
  const producer = (wine?.producer || '').trim();
  const name = (wine?.name || '').trim();
  const year = vintage && vintage !== 'Unknown' ? String(vintage) : '';
  const label = title || [producer, name, year].filter(Boolean).join(' ');

  const cx = VIEW_W / 2;
  const producerEm = TEXT_W / PRODUCER_SIZE;
  const producerLines = clampLines(wrapWords(producer.toUpperCase(), producerEm), PRODUCER_MAX_LINES, producerEm);
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
        <>
          <clipPath id={clipId}>
            <rect x={LABEL.x + 1} y={LABEL.y} width={LABEL.w - 2} height={LABEL.h} />
          </clipPath>
          <g className="bottle-placeholder__text" textAnchor="middle" clipPath={`url(#${clipId})`}>
            {producerLines.map((l, i) => (
              <text key={`p${i}`} x={cx} y={producerTop + i * producerGap} fontSize={PRODUCER_SIZE} className="bottle-placeholder__producer">{l}</text>
            ))}
            {lines.map((l, i) => (
              <text key={`n${i}`} x={cx} y={nameTop + i * lineH} fontSize={size} className="bottle-placeholder__name">{l}</text>
            ))}
            {year && <text x={cx} y={LABEL.y + LABEL.h - 7} fontSize={VINTAGE_SIZE} className="bottle-placeholder__vintage">{year}</text>}
          </g>
        </>
      )}
    </svg>
  );
}
