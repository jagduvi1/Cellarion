/**
 * Serving advice: temperature and air, composed at read time.
 *
 * The registry stores a TRAIT on the wine's profile (aiProfile.servingTempMin /
 * servingTempMax in °C, aiProfile.needsAir: 'long' | 'short' | 'none'), never
 * a sentence. Whether to decant depends on where the vintage is in its life,
 * which moves every year, so "decant about an hour" written down today is
 * wrong in ten years. The bottle page and the MCP answers compose the advice
 * from the trait and the vintage's maturity phase TODAY (utils/maturityUtils
 * classifyMaturity / the page's drinkStatus), the same way a stored window
 * becomes "peak" or "late" on the day it is read.
 *
 * Nothing has to be filled in for this to work: the temperature falls back to
 * the style (type + body) and the air trait to the type, so every wine has a
 * line from day one and the sommelier only overrides where a wine deserves it.
 *
 * Mirrored in frontend/src/utils/serving.js — keep the tables identical.
 */

const NEEDS_AIR = ['long', 'short', 'none'];
const SERVING_TEMP_MIN_C = 0;
const SERVING_TEMP_MAX_C = 30;

// Serving temperature by style, °C. Reds by body (a light Gamay or Pinot sits
// cooler than a full Cabernet); whites by body too (a full, oaked white is
// served warmer than a crisp one). Unknown body = the span of the type.
const DEFAULT_TEMPS = {
  sparkling: { light: [6, 8],   medium: [6, 8],   full: [8, 10],  unknown: [6, 8] },
  white:     { light: [8, 10],  medium: [9, 11],  full: [10, 12], unknown: [8, 12] },
  'rosé':    { light: [8, 10],  medium: [8, 10],  full: [10, 12], unknown: [8, 10] },
  red:       { light: [13, 15], medium: [15, 17], full: [16, 18], unknown: [15, 18] },
  dessert:   { light: [6, 8],   medium: [6, 8],   full: [8, 10],  unknown: [6, 8] },
  fortified: { light: [8, 10],  medium: [12, 14], full: [14, 16], unknown: [12, 16] },
};

// The air trait a wine of this type has unless the sommelier says otherwise.
// Reds generally gain from a little air; everything else is poured.
const DEFAULT_AIR = { red: 'short', white: 'none', 'rosé': 'none', sparkling: 'none', dessert: 'none', fortified: 'none' };

// What to do with the bottle, by trait and by the vintage's phase today.
// Codes, not sentences: the page translates them, an assistant reads them.
//   decant_long    — decant one to two hours
//   decant_short   — open thirty minutes ahead, or decant briefly
//   open_ahead     — open half an hour ahead
//   pour           — open and pour
//   pour_careful   — open and pour; sediment is likely, pour carefully
const AIR_BY_PHASE = {
  long:  { 'not-ready': 'decant_long', early: 'decant_long', peak: 'decant_short', late: 'pour_careful', declining: 'pour_careful' },
  short: { 'not-ready': 'open_ahead',  early: 'open_ahead',  peak: 'pour',         late: 'pour_careful', declining: 'pour_careful' },
  none:  { 'not-ready': 'pour',        early: 'pour',        peak: 'pour',         late: 'pour_careful', declining: 'pour_careful' },
};

function isTemp(v) {
  return Number.isInteger(v) && v >= SERVING_TEMP_MIN_C && v <= SERVING_TEMP_MAX_C;
}

/** The style's default serving temperature for a wine, [min, max] °C, or null for a drink that is not wine. */
function defaultServingTemp(type, body) {
  const byType = DEFAULT_TEMPS[type];
  if (!byType) return null;
  return byType[body] || byType.unknown;
}

/**
 * Compose the serving advice for a wine, at the phase its vintage is in today.
 *
 * @param {object} wine   { type, nonWine, aiProfile: { body, servingTempMin, servingTempMax, needsAir } }
 * @param {string|null} phase  'not-ready' | 'early' | 'peak' | 'late' | 'declining' | null (unknown)
 * @returns {null | { temperature: { min, max, source }, air: null | { trait, code, source } }}
 *   source is 'sommelier' when the trait was set on the profile, 'style' when it is the default.
 *   air is null when no phase is known: the advice would be a guess about the wine's age.
 */
function servingAdvice(wine, phase) {
  if (!wine || wine.nonWine === true) return null;
  const ap = wine.aiProfile || {};
  let temperature = null;
  if (isTemp(ap.servingTempMin) && isTemp(ap.servingTempMax) && ap.servingTempMin <= ap.servingTempMax) {
    temperature = { min: ap.servingTempMin, max: ap.servingTempMax, source: 'sommelier' };
  } else {
    const d = defaultServingTemp(wine.type, ap.body);
    if (d) temperature = { min: d[0], max: d[1], source: 'style' };
  }
  if (!temperature) return null;

  let air = null;
  const trait = NEEDS_AIR.includes(ap.needsAir) ? ap.needsAir : (DEFAULT_AIR[wine.type] || null);
  if (trait && phase && AIR_BY_PHASE[trait][phase]) {
    air = { trait, code: AIR_BY_PHASE[trait][phase], source: NEEDS_AIR.includes(ap.needsAir) ? 'sommelier' : 'style' };
  }
  return { temperature, air };
}

// Plain English for callers that show text rather than translate codes (the
// MCP answers). The page has its own translated strings.
const AIR_TEXT = {
  decant_long: 'decant one to two hours before serving',
  decant_short: 'open thirty minutes ahead, or decant briefly',
  open_ahead: 'open half an hour ahead',
  pour: 'open and pour',
  pour_careful: 'open and pour; sediment is likely, so pour carefully',
};

function servingSentence(advice) {
  if (!advice) return null;
  const t = `Serve at ${advice.temperature.min}–${advice.temperature.max} °C`;
  return advice.air ? `${t}; ${AIR_TEXT[advice.air.code]}.` : `${t}.`;
}

module.exports = {
  NEEDS_AIR,
  SERVING_TEMP_MIN_C,
  SERVING_TEMP_MAX_C,
  DEFAULT_TEMPS,
  DEFAULT_AIR,
  AIR_BY_PHASE,
  AIR_TEXT,
  isTemp,
  defaultServingTemp,
  servingAdvice,
  servingSentence,
};
