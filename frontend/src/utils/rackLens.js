/**
 * Rack "lens" engine — recolors rack slots by a chosen dimension (drink-window
 * maturity, bottle age, rating) and matches bottles against a free-text
 * search so the renderers can dim non-matching slots.
 *
 * The default lens is 'type' (wine type): for it getLensStyle returns null
 * and the renderers fall back to their built-in wine-type colors, so the
 * default view is pixel-identical to the pre-lens behavior.
 *
 * All fills are chosen to read against the wood rack background (#DCC8A4).
 * Maturity hues match the .maturity-badge--* colors in BottleCard.css so the
 * rack speaks the same color language as the bottle list.
 */
import { toNormalized } from './ratingUtils';

export const LENSES = ['type', 'maturity', 'age', 'rating'];

const NEUTRAL = { fill: '#A89880', stroke: '#8A7A64', text: '#fff' };

// ── Maturity (drink window) ──────────────────────────────────────────
const MATURITY_STYLES = {
  'not-ready': { fill: '#6A1B9A', stroke: '#4A148C', text: '#fff' },
  early:       { fill: '#1565C0', stroke: '#0D47A1', text: '#fff' },
  peak:        { fill: '#2E7D32', stroke: '#1B5E20', text: '#fff' },
  late:        { fill: '#E65100', stroke: '#BF360C', text: '#fff' },
  declining:   { fill: '#C62828', stroke: '#8E0000', text: '#fff' },
  none:        NEUTRAL,
};

// ── Age (years since vintage) — single-hue ramp, young → old ─────────
const AGE_BUCKETS = [
  { max: 2,        key: 'age0to2',   fill: '#90CAF9', stroke: '#5B9BD5', text: '#0D2F4C' },
  { max: 5,        key: 'age3to5',   fill: '#42A5F5', stroke: '#1E88E5', text: '#fff' },
  { max: 10,       key: 'age6to10',  fill: '#1E88E5', stroke: '#1565C0', text: '#fff' },
  { max: 20,       key: 'age11to20', fill: '#1565C0', stroke: '#0D47A1', text: '#fff' },
  { max: Infinity, key: 'age20plus', fill: '#0D2F6C', stroke: '#081F4A', text: '#fff' },
];

// ── Rating (normalized 0–100) — diverging ramp, low → high ───────────
const RATING_BUCKETS = [
  { min: 85, key: 'ratingExcellent', fill: '#2E7D32', stroke: '#1B5E20', text: '#fff' },
  { min: 70, key: 'ratingGood',      fill: '#7CB342', stroke: '#558B2F', text: '#233300' },
  { min: 50, key: 'ratingAverage',   fill: '#F9A825', stroke: '#C17900', text: '#3A2A00' },
  { min: 0,  key: 'ratingLow',       fill: '#C62828', stroke: '#8E0000', text: '#fff' },
];

function ageStyle(vintage, currentYear = new Date().getFullYear()) {
  const year = Number(vintage);
  if (!Number.isInteger(year) || year < 1800 || year > currentYear + 1) return NEUTRAL;
  const age = Math.max(0, currentYear - year);
  return AGE_BUCKETS.find(b => age <= b.max) || NEUTRAL;
}

function ratingStyle(rating, ratingScale) {
  const norm = toNormalized(rating, ratingScale || '5');
  if (norm == null) return NEUTRAL;
  return RATING_BUCKETS.find(b => norm >= b.min) || NEUTRAL;
}

/**
 * Style for a filled slot under the given lens: { fill, stroke, text } or
 * null for the default 'type' lens (renderer uses its built-in colors).
 */
export function getLensStyle(lens, bottle, currentYear) {
  if (!bottle) return null;
  switch (lens) {
    case 'maturity': return MATURITY_STYLES[bottle.maturityStatus] || MATURITY_STYLES.none;
    case 'age':      return ageStyle(bottle.vintage, currentYear);
    case 'rating':   return ratingStyle(bottle.rating, bottle.ratingScale);
    default:         return null;
  }
}

// Wine-type legend colors mirror RackRenderer's compact-view palette.
const TYPE_LEGEND = [
  { key: 'red',       fill: '#8A1028' },
  { key: 'white',     fill: '#C8B850' },
  { key: 'rosé',      fill: '#D06888' },
  { key: 'sparkling', fill: '#88A848' },
  { key: 'dessert',   fill: '#A06020' },
  { key: 'fortified', fill: '#7A3010' },
];

/**
 * Legend entries for a lens: [{ tKey, fill }]. tKey is resolved against the
 * translation bundle by the caller ('statistics.typeLabels.*', 'maturity.*',
 * 'rackLens.*').
 */
export function getLensLegend(lens) {
  switch (lens) {
    case 'type':
      return TYPE_LEGEND.map(e => ({ tKey: `statistics.typeLabels.${e.key}`, fill: e.fill }));
    case 'maturity':
      return [
        { tKey: 'maturity.notReady',  fill: MATURITY_STYLES['not-ready'].fill },
        { tKey: 'maturity.early',     fill: MATURITY_STYLES.early.fill },
        { tKey: 'maturity.peak',      fill: MATURITY_STYLES.peak.fill },
        { tKey: 'maturity.late',      fill: MATURITY_STYLES.late.fill },
        { tKey: 'maturity.declining', fill: MATURITY_STYLES.declining.fill },
        { tKey: 'maturity.noData',    fill: NEUTRAL.fill },
      ];
    case 'age':
      return AGE_BUCKETS.map(b => ({ tKey: `rackLens.${b.key}`, fill: b.fill }))
        .concat([{ tKey: 'rackLens.ageNV', fill: NEUTRAL.fill }]);
    case 'rating':
      return RATING_BUCKETS.map(b => ({ tKey: `rackLens.${b.key}`, fill: b.fill }))
        .concat([{ tKey: 'rackLens.ratingNone', fill: NEUTRAL.fill }]);
    default:
      return [];
  }
}

/**
 * Free-text match against a rack slot bottle: wine name, producer,
 * appellation, country, region, grapes and vintage. Empty term matches all.
 */
export function bottleMatchesSearch(bottle, term) {
  const q = (term || '').trim().toLowerCase();
  if (!q) return true;
  const wd = bottle?.wineDefinition || {};
  const haystack = [
    wd.name,
    wd.producer,
    wd.appellation,
    wd.country?.name,
    wd.region?.name,
    ...(Array.isArray(wd.grapes) ? wd.grapes.map(g => g?.name) : []),
    bottle?.vintage,
  ];
  return haystack.some(v => v != null && String(v).toLowerCase().includes(q));
}
