/**
 * Structural extremes that DEFINE a grape — the deterministic half of the
 * regional-prior defence (ticket 6a8464ea, phase 2).
 *
 * The failure this feeds: enrichment gave a Bacchus HIGH acidity — the grape
 * is defined by low acidity, but the model reached for a regional prior.
 * No flag fires on such a row and confidence is mid-high, so no confidence
 * gate can catch it; a factual cross-check can.
 *
 * Deliberately TINY and one-sided: an entry asserts only the extreme the
 * grape is famous for, and the check in enrichmentJob fires only when the
 * generated value is the OPPOSITE extreme ('low' vs 'high') on a wine whose
 * grapes all agree — 'medium' never conflicts with anything, blends with
 * disagreeing grapes are skipped, and a grape absent here is simply not
 * checked. Add an entry only when the opposite extreme would be flatly wrong
 * in ANY normal expression of the variety, late-harvest/appassimento oddities
 * aside — that asymmetry is what keeps false positives ~zero.
 *
 * Keys are normalizeString-folded grape names (lowercase, accents folded).
 */
const GRAPE_STYLE_TYPICALS = {
  // Acidity-defined whites
  riesling:          { acidity: 'high' },
  'sauvignon blanc': { acidity: 'high' },
  albarino:          { acidity: 'high' },
  assyrtiko:         { acidity: 'high' },
  furmint:           { acidity: 'high' },
  'chenin blanc':    { acidity: 'high' },
  bacchus:           { acidity: 'low' },  // the ticket's worked example
  gewurztraminer:    { acidity: 'low' },
  viognier:          { acidity: 'low' },
  marsanne:          { acidity: 'low' },
  // Tannin-defined reds
  'pinot noir':      { tannin: 'low' },
  gamay:             { tannin: 'low' },
  nebbiolo:          { tannin: 'high' },
  tannat:            { tannin: 'high' },
  sagrantino:        { tannin: 'high' },
  'cabernet sauvignon': { tannin: 'high' },
};

const OPPOSITE = { low: 'high', high: 'low' };

/**
 * @param {string[]} grapeNames — the wine's grape names (display spellings)
 * @param {{acidity?: string|null, tannin?: string|null}} profile — CLEANED values
 * @param {(s: string) => string} normalize — utils/normalize.normalizeString
 * @returns {string|null} a human-readable conflict ("bacchus is defined by low
 *   acidity, profile says high"), or null when nothing diagnostic fires.
 */
function findGrapeStyleConflict(grapeNames, profile, normalize) {
  const names = (grapeNames || []).map((n) => normalize(String(n || ''))).filter(Boolean);
  if (names.length === 0) return null;
  for (const axis of ['acidity', 'tannin']) {
    const value = profile?.[axis];
    if (value !== 'low' && value !== 'high') continue; // medium/null never conflict
    // EVERY grape on the wine must assert the opposite extreme — a blend with
    // one non-asserting (or agreeing) grape is not diagnostic.
    const expectations = names.map((n) => GRAPE_STYLE_TYPICALS[n]?.[axis]);
    if (expectations.length === 0 || expectations.some((e) => e !== OPPOSITE[value])) continue;
    return `${names.join('+')} is defined by ${OPPOSITE[value]} ${axis}; profile says ${value}`;
  }
  return null;
}

module.exports = { GRAPE_STYLE_TYPICALS, findGrapeStyleConflict };
