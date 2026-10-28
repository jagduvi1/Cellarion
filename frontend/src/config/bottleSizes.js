/**
 * Canonical bottle sizes (frontend) — mirror of backend/src/config/bottleSizes.js.
 *
 * Stored value is a canonical CODE ('<ml>ml', e.g. '750ml'). Display labels
 * ("Standard", "1.5 L (Magnum)") are derived here via i18n — never stored.
 */

// The instance src/i18n.js configures; importing that module here would pull
// its react-i18next set-up into every component test that mocks it.
import i18n from 'i18next';

export const BOTTLE_SIZES = [
  { ml: 187, code: '187ml', nameKey: 'split' },
  { ml: 375, code: '375ml', nameKey: 'half' },
  { ml: 500, code: '500ml', nameKey: 'halfLitre' },
  { ml: 620, code: '620ml', nameKey: 'clavelin' },
  { ml: 750, code: '750ml', nameKey: 'standard' },
  { ml: 1000, code: '1000ml', nameKey: 'litre' },
  { ml: 1500, code: '1500ml', nameKey: 'magnum' },
  { ml: 3000, code: '3000ml', nameKey: 'doubleMagnum' },
  { ml: 6000, code: '6000ml', nameKey: 'imperial' },
];

export const DEFAULT_SIZE = '750ml';

export function isCanonicalCode(value) {
  return typeof value === 'string' && /^\d+ml$/.test(value);
}

/** Volume in ml from a canonical code, or null. */
export function mlFromCode(code) {
  const m = /^(\d+)ml$/.exec(code || '');
  return m ? parseInt(m[1], 10) : null;
}

// One number formatter per language. Only the number is localised: the units
// stay "ml" and "L", since style: 'unit' turns English "750 ml" into "750 mL".
const volumeFormats = new Map();
function volumeFormat(locale) {
  if (!volumeFormats.has(locale)) {
    let fmt;
    try { fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }); } catch { fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 3 }); }
    volumeFormats.set(locale, fmt);
  }
  return volumeFormats.get(locale);
}

/** Format ml as a friendly volume in the chosen language: 750 → "750 ml", 1500 → "1.5 L" ("1,5 L" in nb). */
export function formatVolume(ml, locale = i18n.language) {
  if (!isFinite(ml) || ml <= 0) return '';
  const fmt = volumeFormat(locale);
  return ml >= 1000 ? `${fmt.format(ml / 1000)} L` : `${fmt.format(ml)} ml`;
}

/** Display label for a code, e.g. "1.5 L (Magnum)" or "900 ml" for unnamed. */
export function bottleSizeLabel(code, t) {
  const ml = mlFromCode(code);
  if (ml == null) return code || '';
  const named = BOTTLE_SIZES.find((s) => s.code === code);
  const vol = formatVolume(ml);
  return named ? `${vol} (${t(`bottleSizeNames.${named.nameKey}`)})` : vol;
}

/** Normalize any input to a canonical "<ml>ml" code, or null. (Mirror of backend.) */
export function normalizeBottleSize(input) {
  if (input == null) return null;

  if (typeof input === 'number') {
    if (!isFinite(input) || input <= 0) return null;
    const ml = input < 20 ? input * 1000 : input;
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
  else if (unit) ml = val * 1000;
  else ml = val < 20 ? val * 1000 : val;

  ml = Math.round(ml);
  return ml > 0 ? `${ml}ml` : null;
}
