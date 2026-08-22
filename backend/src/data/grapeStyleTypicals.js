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
 * ---------------------------------------------------------------------------
 * NO 'low' TANNIN ENTRIES. EVER. (somm ticket 6a896b7e, 2026-08-22)
 *
 * The table shipped with `pinot noir: { tannin: 'low' }` and it was wrong on
 * both records it ever fired on — two correct Pommards, flagged for having
 * the firm tannin Pommard is *known* for. 588 single-variety Pinot Noir rows
 * were exposed to it, including Nuits-Saint-Georges, Gevrey-Chambertin and
 * Central Otago, all appellations where grip is typical rather than anomalous.
 *
 * The reason is structural, not a matter of picking better varieties:
 *
 *   ACIDITY is set by the grape. A variety that ripens with low malic acid
 *   cannot be made high-acid, so "defined by low acidity" is a real claim.
 *
 *   HIGH TANNIN is set by the grape too — thick skins and high polyphenols
 *   put a FLOOR under it, so a low-tannin Nebbiolo really is a defect.
 *
 *   LOW TANNIN is set by the WINEMAKER. Extraction time, whole-cluster,
 *   new oak and press fraction can all carry a thin-skinned variety well
 *   past "low", and entire appellations are famous for exactly that. It is
 *   a ceiling nobody enforces, so it cannot be asserted as definitional.
 *
 * So: `tannin: 'high'` entries are legitimate; `tannin: 'low'` entries are
 * not, whatever the variety. Gamay went out with Pinot Noir under the same
 * rule — cru Beaujolais (Moulin-à-Vent, Morgon) is structured on purpose and
 * would have been the next false positive. An invariant test enforces this.
 * ---------------------------------------------------------------------------
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
  // Tannin-defined reds. HIGH only — see the note above on why 'low' tannin
  // is a winemaking outcome rather than a varietal definition.
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
