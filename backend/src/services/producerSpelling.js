/**
 * Canonical producer SPELLING at mint time (registry strategy 2026-07-29, R1;
 * widened 2026-08-14 after the producer-display consolidation).
 *
 * The producer is a free string, and every dedup mechanism in the registry —
 * normalizedKey, canonicalKey, duplicate clusters, sibling matching — is
 * derived from it. The keys themselves are spelling-proof (normalizeString
 * folds accents/case/punctuation), which is exactly why display splits slip
 * through every net: "Cave de Ribeauvillé" (12 wines) and a hand-typed "Cave
 * de Ribeauville" (1 wine) never collide on any KEY, so nothing ever flagged
 * them, and the registry showed two producers where the world has one
 * (support ticket 2026-07-28, finding 2).
 *
 * The fix is at the source: when a NEW wine is about to be minted, adopt the
 * spelling the registry already uses for this producer. Two stages, both
 * SILENT and both fail-open — an add must never get harder, so on any doubt
 * the typed spelling is kept and the display-split watchdog counts what's
 * left for the next cleanup pass:
 *
 *   1. SAME normalized string (accent/case/punctuation variants): adopt the
 *      majority spelling. Unchanged from R1.
 *
 *   2. SAME producer comparison key, SAME country (decoration variants:
 *      "Philipp Kuhn" vs "Weingut Philipp Kuhn", "Felton Road Wines Ltd" vs
 *      "Felton Road"). This is the split class stage 1 is blind to — the
 *      2026-08-14 consolidation found 130 such clusters, minted mostly by the
 *      LWIN import (whose PRODUCER_NAME column drops the estate title that
 *      label scans include). Guarded three ways, because the key
 *      DELIBERATELY over-folds (Domaine vs Bodegas Chandon share one; so do
 *      Napa's two Stags Leap estates):
 *        - country must match — "Weingut Jordan" (DE) never captures a new
 *          "Jordan Winery" (US) wine;
 *        - the bucket must hold exactly ONE existing spelling group — a
 *          genuinely contested bucket (Château de Seguin vs Chateau Seguin,
 *          two Bordeaux estates) adopts nothing;
 *        - the typed spelling must differ from the registry's only by
 *          DECORATION (its token set a subset/superset of the target's) — a
 *          typo ("Philip Kuhn") or a differently-worded name ("Stags Leap
 *          Winery" vs "Stag's Leap Wine Cellars") is never auto-adopted;
 *          those go to a human, matching the never-auto-merge rule the
 *          canonical-collision queue already follows.
 *
 * Majority = most wines, ties broken by the spelling whose earliest wine is
 * oldest (stability: the registry's original spelling wins a 1-vs-1).
 *
 * Mint-time only, like the producer-is-a-place gate: existing rows are
 * unified by scripts/consolidate-producer-displays.js and stay consistent
 * from then on because this function prevents new divergence.
 *
 * ...except that a producer can also change on an EXISTING wine, and there
 * the resolver never runs. otherProducerSpellings / planProducerRename below
 * serve that path (approving a producer correction, routes/admin/
 * wineProposals.js): 9 of the 51 producer corrections approved in the week
 * to 2026-09-28 gave one wine a spelling the rest of its producer did not
 * use, and each became a display split the weekly registry-health check
 * rang for. They only REPORT and PLAN — which spelling wins stays a human's
 * call, because the bucket deliberately over-folds (two real Bordeaux
 * estates can share one).
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { escapeRegex } = require('../utils/sanitize');
const { normalizeString, generateWineKey, isIdentitySentinel } = require('../utils/normalize');
const { producerSegment } = require('../utils/wineIdentity');

/** Do two normalized spellings differ only by decoration? (token subset,
 *  either direction — "philipp kuhn" ⊂ "weingut philipp kuhn", and the
 *  reverse when the typed form is the fuller one) */
const decorationOnlyDiff = (aNorm, bNorm) => {
  const a = new Set(aNorm.split(' ').filter(Boolean));
  const b = new Set(bNorm.split(' ').filter(Boolean));
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (!big.has(t)) return false;
  return true;
};

/**
 * @param {string} rawProducer   trimmed display producer the caller wants to store
 * @param {string} producerNorm  normalizeString(rawProducer) — caller already has it
 * @param {object} [opts]
 * @param {*}      [opts.countryId] the wine's resolved Country _id. Enables
 *   stage 2; without it only the same-string stage runs (the pre-2026-08-14
 *   behavior), because cross-estate safety needs the country fence.
 * @returns {Promise<string>} the spelling to store (the registry's canonical
 *   one, or the input when this producer is new / contested / not a pure
 *   decoration variant). Never throws — on lookup failure the input spelling
 *   is kept; a mint must not fail over a display nicety.
 */
async function resolveCanonicalProducerSpelling(rawProducer, producerNorm, opts = {}) {
  if (!producerNorm) return rawProducer;
  try {
    // Stage 1 — same normalized string, any country: pure spelling variants.
    const rows = await WineDefinition.aggregate([
      // Quarantined rows keep their spelling but don't get a vote — a nonWine
      // row's producer is exactly the kind of data we don't want to copy.
      { $match: { normalizedKey: new RegExp(`^${escapeRegex(producerNorm)}:`), nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
      { $group: { _id: '$producer', count: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
      { $sort: { count: -1, oldest: 1 } },
      { $limit: 1 },
    ]);
    if (rows[0]?._id) return rows[0]._id;

    // Stage 2 — same producer KEY, same country: decoration variants. Only
    // when stage 1 found nothing (this producer string is new to the
    // registry) and the caller could fence by country.
    if (!opts.countryId) return rawProducer;
    const seg = producerSegment(rawProducer);
    if (!seg) return rawProducer;
    // Aggregation pipelines bypass mongoose casting, so a caller handing over
    // a string id (the admin routes hold the body value) would silently match
    // nothing. Cast here — one place, every caller safe. An uncastable value
    // passes through raw (matches nothing → keeps the typed spelling), rather
    // than throwing its way into the catch.
    const countryId = mongoose.isValidObjectId(opts.countryId)
      ? new mongoose.Types.ObjectId(String(opts.countryId))
      : opts.countryId;
    const keyRows = await WineDefinition.aggregate([
      // canonicalKey's first segment IS producerSegment (utils/wineIdentity),
      // and ':' can never appear inside it (normalizeString strips
      // punctuation), so the anchored prefix scan is exact — and indexed.
      { $match: {
        canonicalKey: new RegExp(`^${escapeRegex(seg)}:`),
        country: countryId,
        nonWine: { $ne: true },
        pendingIdentity: { $ne: true },
      } },
      { $group: { _id: '$producer', count: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
    ]);
    if (keyRows.length === 0) return rawProducer;

    // Fold raw spellings into normalized groups; adopt only from an
    // UNCONTESTED bucket. (Two groups = either an unconsolidated split or two
    // real estates sharing a key — both are a human's call, not a mint's.)
    const groups = new Map(); // norm -> { count, oldest, best: {raw, count, oldest} }
    for (const r of keyRows) {
      const norm = normalizeString(r._id || '');
      if (!norm) continue;
      let g = groups.get(norm);
      if (!g) { g = { count: 0, oldest: null, best: null }; groups.set(norm, g); }
      g.count += r.count;
      if (g.oldest === null || (r.oldest && r.oldest < g.oldest)) g.oldest = r.oldest;
      if (!g.best || r.count > g.best.count ||
          (r.count === g.best.count && r.oldest && g.best.oldest && r.oldest < g.best.oldest)) {
        g.best = { raw: r._id, count: r.count, oldest: r.oldest };
      }
    }
    if (groups.size !== 1) return rawProducer;
    const [targetNorm, group] = groups.entries().next().value;
    if (!decorationOnlyDiff(producerNorm, targetNorm)) return rawProducer;
    return group.best.raw;
  } catch (err) {
    console.warn('[producerSpelling] lookup failed (non-fatal, keeping input):', err.message);
    return rawProducer;
  }
}

// The display form the registry-health metric groups spellings by
// (services/registryHealthJob), so a spelling reported here is exactly one
// that metric would count as a split.
const displaySpelling = (s) => String(s || '').trim().replace(/\s+/g, ' ');

const castId = (id) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : id);

// The display-split bucket — same producer comparison key, same country,
// quarantined and pending rows out — as a $match. canonicalKey's first
// segment IS producerSegment (see stage 2 above), so the prefix is exact.
function bucketMatch(seg, countryId, excludeWineId) {
  const match = {
    canonicalKey: new RegExp(`^${escapeRegex(seg)}:`),
    country: castId(countryId),
    nonWine: { $ne: true },
    pendingIdentity: { $ne: true },
  };
  if (excludeWineId) match._id = { $ne: castId(excludeWineId) };
  return match;
}

/**
 * The OTHER spellings the registry already uses for this producer — the
 * wines the weekly display-split metric would pair with `spelling`.
 *
 * @param {string} spelling  the producer about to be stored on a wine
 * @param {*} countryId      that wine's Country _id after the write
 * @param {object} [opts]
 * @param {*} [opts.excludeWineId] the wine being corrected — its own current
 *   spelling is about to change, so it is not "another" one
 * @param {boolean} [opts.strict] rethrow a lookup failure instead of
 *   answering [] — for the approve itself, where "no other spelling" would
 *   silently apply a split the admin never saw
 * @returns {Promise<Array<{spelling: string, count: number}>>} most wines
 *   first; [] when there are none, for a sentinel producer, or (not strict)
 *   on a lookup failure — informing a list or a reply must never block it
 */
async function otherProducerSpellings(spelling, countryId, { excludeWineId = null, strict = false } = {}) {
  const display = displaySpelling(spelling);
  if (!display || !countryId || isIdentitySentinel(display)) return [];
  const seg = producerSegment(display);
  if (!seg) return [];
  try {
    const rows = await WineDefinition.aggregate([
      { $match: bucketMatch(seg, countryId, excludeWineId) },
      { $group: { _id: '$producer', count: { $sum: 1 } } },
    ]);
    const counts = new Map();
    for (const r of rows) {
      const s = displaySpelling(r._id);
      if (!s || s === display || isIdentitySentinel(s)) continue;
      counts.set(s, (counts.get(s) || 0) + r.count);
    }
    return [...counts]
      .map(([s, count]) => ({ spelling: s, count }))
      .sort((a, b) => (b.count - a.count) || a.spelling.localeCompare(b.spelling));
  } catch (err) {
    if (strict) throw err;
    console.warn('[producerSpelling] other-spellings lookup failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Plan renaming every wine that stores one of `fromSpellings` (in the same
 * bucket) to `to` — the "rename them all" answer to a spelling split. Reads
 * only; the caller saves the returned docs (doc.save() so the model hooks
 * own canonicalKey, the slug with its previousSlugs and the verifiedChecks
 * invalidation — the scripts/consolidate-producer-displays.js write path).
 *
 * normalizedKey is UNIQUE and not hook-maintained, so every new key is
 * checked first: against the rest of the registry, against the other wines
 * in the plan, and against `reservedKeys` (the corrected wine's own new key).
 * Any clash means two wines would become one — that is a merge, not a
 * rename, so the plan reports it and the caller writes nothing.
 *
 * @returns {Promise<{wines: Array<{doc, from: string, newKey: string}>,
 *   clashes: Array<{wineId: string, name: string, from: string}>, tooMany: number}>}
 *   tooMany is the wine count when it exceeds `max` (then wines is empty).
 */
async function planProducerRename(fromSpellings, to, countryId, { excludeWineId = null, reservedKeys = [], max = 200 } = {}) {
  const target = displaySpelling(to);
  const from = new Set((fromSpellings || []).map(displaySpelling).filter((s) => s && s !== target));
  const empty = { wines: [], clashes: [], tooMany: 0 };
  const seg = producerSegment(target);
  if (!from.size || !seg || !countryId) return empty;

  const docs = (await WineDefinition.find(bucketMatch(seg, countryId, excludeWineId)))
    .filter((d) => from.has(displaySpelling(d.producer)));
  if (docs.length > max) return { ...empty, tooMany: docs.length };

  const wines = docs.map((doc) => ({
    doc, from: displaySpelling(doc.producer), newKey: generateWineKey(doc.name, target, doc.appellation),
  }));
  const taken = new Set(reservedKeys.filter(Boolean));
  const clashes = [];
  const clash = (w) => clashes.push({ wineId: String(w.doc._id), name: w.doc.name, from: w.from });
  const planned = new Set();
  for (const w of wines) {
    if (taken.has(w.newKey) || planned.has(w.newKey)) clash(w);
    planned.add(w.newKey);
  }
  if (wines.length) {
    const existing = await WineDefinition.find({
      normalizedKey: { $in: [...planned] },
      _id: { $nin: wines.map((w) => w.doc._id).concat(excludeWineId ? [castId(excludeWineId)] : []) },
    }).select('normalizedKey').lean();
    const existingKeys = new Set(existing.map((e) => e.normalizedKey));
    for (const w of wines) {
      if (existingKeys.has(w.newKey) && !clashes.some((c) => c.wineId === String(w.doc._id))) clash(w);
    }
  }
  return { wines, clashes, tooMany: 0 };
}

module.exports = { resolveCanonicalProducerSpelling, otherProducerSpellings, planProducerRename, displaySpelling };
