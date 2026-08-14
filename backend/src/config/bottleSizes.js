/**
 * Canonical bottle sizes — single source of truth (backend).
 *
 * The stored value on `Bottle.bottleSize` is a canonical CODE: the volume in
 * millilitres followed by "ml" (e.g. '750ml', '1500ml'). Display labels
 * ("Standard", "Magnum", "1.5 L") are derived in the frontend via i18n — we
 * never store a localized label, which is what produced the historical mess
 * ('750ml (Standard)', '750ml（標準）', '1.5L', …).
 *
 * Mirror of frontend/src/config/bottleSizes.js (kept in sync by hand, like
 * config/currencies and config/plans).
 */

// Named formats. `nameKey` resolves to i18n `bottleSizeNames.<key>` on the UI.
const BOTTLE_SIZES = [
  { ml: 187, code: '187ml', nameKey: 'split' },
  { ml: 375, code: '375ml', nameKey: 'half' },
  { ml: 500, code: '500ml', nameKey: 'halfLitre' },
  { ml: 620, code: '620ml', nameKey: 'clavelin' },     // Jura vin jaune
  { ml: 750, code: '750ml', nameKey: 'standard' },
  { ml: 1000, code: '1000ml', nameKey: 'litre' },     // Alsace/German/Austrian everyday format
  { ml: 1500, code: '1500ml', nameKey: 'magnum' },
  { ml: 3000, code: '3000ml', nameKey: 'doubleMagnum' },
  { ml: 6000, code: '6000ml', nameKey: 'imperial' },
];

const CANONICAL_CODES = new Set(BOTTLE_SIZES.map((s) => s.code));
const DEFAULT_SIZE = '750ml';

/** A code is canonical if it matches the "<positive integer>ml" shape. */
function isCanonicalCode(value) {
  return typeof value === 'string' && /^\d+ml$/.test(value);
}

/**
 * Normalize any bottle-size input to a canonical "<ml>ml" code, or null when no
 * volume can be parsed. Handles localized labels, L/cl/ml units, EU decimal
 * commas, bare numbers, and trailing label text in any script.
 *   '750ml (Standard)' → '750ml'   '750ml（標準）' → '750ml'
 *   '1.5L (Magnum)'    → '1500ml'  '0,75 l'      → '750ml'
 *   '620ml'            → '620ml'   750            → '750ml'   '1.5' → '1500ml'
 */
function normalizeBottleSize(input) {
  if (input == null) return null;

  if (typeof input === 'number') {
    if (!isFinite(input) || input <= 0) return null;
    const ml = input < 20 ? input * 1000 : input; // a bare number < 20 is litres
    return `${Math.round(ml)}ml`;
  }

  const s = String(input).trim().toLowerCase().replace(',', '.');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(ml|cl|cℓ|l|ℓ|litre|liter|litres|liters)?/);
  if (!m) return null;

  const val = parseFloat(m[1]);
  if (!isFinite(val) || val <= 0) return null;

  const unit = m[2];
  let ml;
  if (unit === 'ml') ml = val;
  else if (unit === 'cl' || unit === 'cℓ') ml = val * 10;
  else if (unit) ml = val * 1000; // litre variants
  else ml = val < 20 ? val * 1000 : val; // unitless: < 20 → litres, else ml

  ml = Math.round(ml);
  return ml > 0 ? `${ml}ml` : null;
}

module.exports = {
  BOTTLE_SIZES,
  CANONICAL_CODES,
  DEFAULT_SIZE,
  isCanonicalCode,
  normalizeBottleSize,
};
