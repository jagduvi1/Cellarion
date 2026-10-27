/**
 * Serving advice, composed at read time from the wine's profile trait and the
 * vintage's maturity phase today. Mirrors backend/src/utils/servingUtils.js:
 * keep the tables identical (both are pinned by tests).
 *
 * The registry stores a trait (serving temperature in °C, whether the wine
 * needs air when young), never a sentence: whether to decant depends on where
 * the vintage is in its life, which moves every year.
 */

export const NEEDS_AIR = ['long', 'short', 'none'];

export const DEFAULT_TEMPS = {
  sparkling: { light: [6, 8],   medium: [6, 8],   full: [8, 10],  unknown: [6, 8] },
  white:     { light: [8, 10],  medium: [9, 11],  full: [10, 12], unknown: [8, 12] },
  'rosé':    { light: [8, 10],  medium: [8, 10],  full: [10, 12], unknown: [8, 10] },
  red:       { light: [13, 15], medium: [15, 17], full: [16, 18], unknown: [15, 18] },
  dessert:   { light: [6, 8],   medium: [6, 8],   full: [8, 10],  unknown: [6, 8] },
  fortified: { light: [8, 10],  medium: [12, 14], full: [14, 16], unknown: [12, 16] },
};

export const DEFAULT_AIR = { red: 'short', white: 'none', 'rosé': 'none', sparkling: 'none', dessert: 'none', fortified: 'none' };

export const AIR_BY_PHASE = {
  long:  { 'not-ready': 'decant_long', early: 'decant_long', peak: 'decant_short', late: 'pour_careful', declining: 'pour_careful' },
  short: { 'not-ready': 'open_ahead',  early: 'open_ahead',  peak: 'pour',         late: 'pour_careful', declining: 'pour_careful' },
  none:  { 'not-ready': 'pour',        early: 'pour',        peak: 'pour',         late: 'pour_careful', declining: 'pour_careful' },
};

const isTemp = (v) => Number.isInteger(v) && v >= 0 && v <= 30;

export function defaultServingTemp(type, body) {
  const byType = DEFAULT_TEMPS[type];
  if (!byType) return null;
  return byType[body] || byType.unknown;
}

/**
 * @param {object} wine   the bottle's wine: { type, nonWine, aiProfile }
 * @param {string|null} phase  the vintage's phase today, or null when unknown
 * @returns {null | { temperature: { min, max, source }, air: null | { trait, code, source } }}
 */
export function servingAdvice(wine, phase) {
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

/** The line the bottle page shows, translated. */
export function servingText(advice, t) {
  if (!advice) return '';
  const temp = t('serving.temperature', 'Serve at {{min}}–{{max}} °C', { min: advice.temperature.min, max: advice.temperature.max });
  if (!advice.air) return `${temp}.`;
  return `${temp}; ${t(`serving.air.${advice.air.code}`)}.`;
}
