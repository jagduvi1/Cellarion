import { fromNormalized, formatRating, formatDelta, SCALE_META } from '../../utils/ratingUtils';

// ── Color palette ─────────────────────────────────────────────────────────────
export const TYPE_COLORS = {
  red:       '#C0504D',
  white:     '#D4C87A',
  'ros\u00e9':    '#E8A0B0',
  sparkling: '#6EC6C6',
  dessert:   '#D4A070',
  fortified: '#8B6A9A',
  unknown:   '#6a6a6a',
};

export const REASON_COLORS = {
  drank:  '#7A1E2D',
  gifted: '#5B8DB8',
  sold:   '#D4A373',
  other:  '#8A8580',
};

export const COUNTRY_COLORS = [
  '#7A1E2D', '#8C2A3A', '#A03648', '#621826', '#4D1220',
  '#D4A373', '#C49363', '#B48353', '#A47343', '#946333',
  '#5B8DB8', '#4B7DA8', '#3B6D98', '#2B5D88', '#1B4D78',
];

export const GRAPE_COLORS = [
  '#C0504D', '#B0403D', '#A0302D', '#90201D', '#80100D',
  '#E8A0B0', '#D890A0', '#C88090', '#B87080', '#A86070',
  '#8B6A9A', '#7B5A8A', '#6B4A7A', '#5B3A6A', '#4B2A5A',
];

export const GRADE_COLORS = { A: '#2D7A45', B: '#D4C87A', C: '#D4A373', D: '#C0504D', F: '#9A2020' };

export const RATING_BAND_DEFS = [
  { key: '81-100', labelKey: 'excellent', color: '#7A1E2D' },
  { key: '61-80',  labelKey: 'veryGood', color: '#D4C87A' },
  { key: '41-60',  labelKey: 'good',      color: '#D4A070' },
  { key: '21-40',  labelKey: 'fair',      color: '#C08050' },
  { key: '0-20',   labelKey: 'poor',      color: '#C0504D' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
export function fmt(n) {
  if (n == null) return '\u2014';
  return n.toLocaleString();
}

/**
 * Format a normalized 0-100 rating for display in the user's preferred scale.
 */
export function fmtRating(normalized, targetScale) {
  if (normalized == null) return '\u2014';
  const scale = SCALE_META[targetScale] ? targetScale : '5';
  const converted = fromNormalized(normalized, scale);
  return formatRating(converted, scale);
}

/**
 * Format a normalized delta for display in the user's preferred scale.
 */
export function fmtDelta(normalizedDelta, targetScale) {
  if (normalizedDelta == null) return '\u2014';
  const scale = SCALE_META[targetScale] ? targetScale : '5';
  return formatDelta(normalizedDelta, scale);
}

/**
 * Return a tooltip string for a rating band in the user's preferred scale.
 */
export function bandSub(bandKey, targetScale) {
  const scale = SCALE_META[targetScale] ? targetScale : '5';
  const [lo, hi] = bandKey.split('-').map(Number);
  const meta = SCALE_META[scale];
  const prec = meta.step < 1 ? 1 : 0;
  const loVal = fromNormalized(lo, scale);
  const hiVal = fromNormalized(hi, scale);
  return `${loVal.toFixed(prec)}\u2013${hiVal.toFixed(prec)}${meta.suffix}`;
}

export function fmtCurrency(amount, currency) {
  if (!amount && amount !== 0) return '\u2014';
  if (amount === 0) return '\u2014';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${fmt(amount)}`;
  }
}

export function fmtDays(days, t) {
  if (days === null || days === undefined) return '\u2014';
  if (days < 0) return t('statistics.days.overdue', { count: Math.abs(days) });
  if (days === 0) return t('statistics.days.today');
  return t('statistics.days.left', { count: days });
}
