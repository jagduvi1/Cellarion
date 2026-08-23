/**
 * Same wine, different label form.
 *
 * Somm ticket e9b346ba (2026-08-23). One import file carried the same wine
 * more than once under variant names and nothing collided: `normalizedKey` is
 * exact, and the fuzzy scorer never got close. Measured against the 17 pairs a
 * curator merged by hand that day, EVERY pair scored below 0.85 — the floor of
 * even the "did you mean?" soft zone — spread across 0.58 to 0.85:
 *
 *   Bin 389 / Bin 389 Cabernet Shiraz .................. 0.717
 *   RWT / RWT Shiraz ................................... 0.721
 *   pHat / pHat Chardonnay ............................. 0.708
 *   Shiraz Cask 66 / Cask 66 Shiraz .................... 0.788
 *   Kangarilla / Old Vines Grenache Kangarilla ......... 0.689
 *
 * So no threshold move could have caught them: reaching the worst pair means
 * ~0.58, which would fold genuinely different wines together. The signal has
 * to come from NORMALISING before comparing, not from a looser cut-off.
 *
 * What makes these pairs invisible is that the differing tokens carry no
 * identity — a variety name, an "Old Vines" prefix, plain word order. Strip
 * those and the remainders are equal. That is the whole detector:
 *
 *   name        → fold accents, lowercase, drop punctuation
 *   tokens      → drop variety names (from the live taxonomy), label
 *                 furniture, and the row's own appellation tokens
 *   compare     → set equality, so word order stops mattering
 *
 * THE GUARD THAT KEEPS IT HONEST. Reduced-set equality ALONE would merge a
 * range bottled in several varietals: Zuccardi "Q Cabernet Franc" and "Q
 * Malbec" both reduce to "q". The curator's own rule decides it — where both
 * sides name a DIFFERENT variety they are two wines; where one side names a
 * variety and the other names none, it is one wine written twice. So the
 * stripped varieties must be COMPATIBLE: one side's set empty, or one a
 * subset of the other. Disjoint non-empty variety sets are a hard reject.
 *
 * WHAT THIS DELIBERATELY CANNOT DO. A vineyard or site token dropped from a
 * later label (Penfolds "Kalimna Bin 28" → "Bin 28 Shiraz") is the same class
 * of change, and it is NOT handled here — deliberately, not by oversight.
 * Vineyard names cannot join the strip list because for some producers the
 * vineyard IS the wine: Clarendon Hills bottle Kangarilla, Blewitt Springs and
 * Brookman as separate wines, and stripping site names would collapse their
 * whole range into one row. A rule that fixes Penfolds breaks Clarendon Hills,
 * so that case stays a curator judgement. Do not read the four transformations
 * below as the complete set.
 */
const { normalizeString } = require('../utils/normalize');

// Label furniture: real words on labels that never distinguish two wines of
// the same producer. "Old Vines" is the curator's transformation #2; the rest
// are the connectives that survive normalisation.
const FURNITURE = new Set([
  'old', 'vine', 'vines', 'vieilles', 'vignes',
  'de', 'du', 'des', 'la', 'le', 'les', 'el', 'los', 'las', 'il', 'the',
  'and', 'et', 'y',
]);

const fold = (s) => normalizeString(String(s || ''));
const tokens = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Build the variety-token lookup once per call site.
 * @param {Array} surfaceForms from services/grapeInference.buildSurfaceForms
 * @returns {Set<string>} single tokens that name a grape
 */
function grapeTokenSet(surfaceForms) {
  const set = new Set();
  for (const { form } of surfaceForms || []) {
    for (const t of String(form).split(/[^a-z0-9]+/)) {
      // 3+ chars only: a two-letter fragment of a variety name would eat
      // real cuvée tokens ("LJ", "MC", "Q") and gut the comparison.
      if (t && t.length > 2) set.add(t);
    }
  }
  return set;
}

/**
 * Reduce a wine name to its identifying tokens.
 * @returns {{core: Set<string>, varieties: Set<string>}}
 */
function reduceName(name, { grapeTokens, appellation } = {}) {
  const apTokens = new Set(tokens(appellation));
  const varieties = new Set();
  const build = (stripAppellation) => {
    const core = new Set();
    for (const t of tokens(name)) {
      if (grapeTokens && grapeTokens.has(t)) { varieties.add(t); continue; }
      if (FURNITURE.has(t)) continue;
      // The appellation repeated inside the name adds nothing — it is already
      // its own field.
      if (stripAppellation && apTokens.has(t)) continue;
      core.add(t);
    }
    return core;
  };
  let core = build(true);
  // …unless the appellation IS the name. Clarendon Hills name their wines for
  // the vineyard AND file it as the appellation, so stripping it leaves
  // nothing and "Kangarilla" would stop matching "Old Vines Grenache
  // Kangarilla" — the very pair this detector exists for. Keep the
  // appellation tokens when they are all a name has.
  if (core.size === 0) core = build(false);
  return { core, varieties };
}

const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const subset = (a, b) => [...a].every((x) => b.has(x));

/**
 * Are these two names the same wine under different label forms?
 *
 * @param {{name:string, appellation?:string, grapes?:Array}} a
 * @param {{name:string, appellation?:string, grapes?:Array}} b
 * @param {Set<string>} grapeTokens from grapeTokenSet()
 * @returns {{match:boolean, reason:string}}
 */
function isLabelVariant(a, b, grapeTokens) {
  const ra = reduceName(a.name, { grapeTokens, appellation: a.appellation });
  const rb = reduceName(b.name, { grapeTokens, appellation: b.appellation });

  // An empty core means the name was ENTIRELY furniture and varieties
  // ("Chardonnay"): nothing identifying is left, so equality here would match
  // every varietal wine of the producer to every other.
  if (ra.core.size === 0 || rb.core.size === 0) {
    return { match: false, reason: 'no identifying tokens after reduction' };
  }
  if (!eqSet(ra.core, rb.core)) {
    return { match: false, reason: 'reduced names differ' };
  }
  // The guard: differing named varieties mean two wines in one range.
  if (ra.varieties.size > 0 && rb.varieties.size > 0
      && !subset(ra.varieties, rb.varieties) && !subset(rb.varieties, ra.varieties)) {
    return { match: false, reason: 'each name states a different variety — a range, not a duplicate' };
  }
  // Corroborate against the stored grape lists when BOTH rows have them: two
  // records of one wine cannot disagree about what it is made from. A missing
  // list is silence, not disagreement.
  const idsOf = (w) => new Set((w.grapes || [])
    .map((g) => String((g && g._id) ? g._id : g)).filter(Boolean));
  const ga = idsOf(a);
  const gb = idsOf(b);
  if (ga.size > 0 && gb.size > 0 && !subset(ga, gb) && !subset(gb, ga)) {
    return { match: false, reason: 'stored grape lists disagree' };
  }
  return { match: true, reason: `same reduced name "${[...ra.core].sort().join(' ')}"` };
}

module.exports = { isLabelVariant, reduceName, grapeTokenSet, FURNITURE };
