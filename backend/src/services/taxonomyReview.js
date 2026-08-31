/**
 * The registry's taxonomy review queues, shared by the admin REST routes and
 * the admin MCP tools so the two surfaces cannot drift (the same reason
 * wineProfileOps/bottleOps exist).
 *
 * Two queues, one philosophy (strategy 2026-07-29): user writes are never
 * blocked by taxonomy — doubt is routed here instead.
 *   - Pending regions (R3): auto-minted by a user write, awaiting an admin's
 *     approve / merge / fix.
 *   - Unmatched appellations (R2): free-text appellation strings on wines
 *     that no curated Appellation doc covers, candidates for promotion.
 */
const WineDefinition = require('../models/WineDefinition');
const Region = require('../models/Region');
const Country = require('../models/Country');
const Appellation = require('../models/Appellation');
const AppellationReviewSkip = require('../models/AppellationReviewSkip');
const { normalizeAppellation, normalizeAppellationKey } = require('../utils/normalize');
const { candidateKeys } = require('./appellationResolve');
const { isValidId } = require('../utils/validation');
const { stripHtml } = require('../utils/sanitize');

/**
 * Ref validation for an Appellation write (code audit 2026-07-30: "appellation
 * region not checked against country"). The schema declares country and region
 * refs but Mongoose verifies neither that the ids exist nor that the region
 * belongs to the country — listUnmatchedAppellations() below even drops
 * cross-country suggestions on the assumption the schema enforces this, which
 * it never did. Every write surface (REST create/update, MCP
 * promote_appellation) shares this one check so the invariant holds no matter
 * what the caller sends and the surfaces cannot drift.
 *
 * @param {*} countryId  required — the appellation's country
 * @param {*} regionId   optional — validated only when set
 * @returns {Promise<string|null>} a human-readable error, or null when valid.
 */
async function appellationRefsError(countryId, regionId) {
  // Queries use the STRING that passed isValidId, never the raw input — the
  // caller may hand us an ObjectId (the PUT path) or request-body junk, and
  // querying the validated derivative is what keeps operator objects out of
  // the filter (CodeQL js/sql-injection).
  const countryKey = String(countryId ?? '');
  if (!isValidId(countryKey)) return 'A valid country id is required';
  const countryExists = await Country.exists({ _id: countryKey });
  if (!countryExists) return 'No country with that id';
  if (!regionId) return null;
  const regionKey = String(regionId);
  if (!isValidId(regionKey)) return 'Invalid region id';
  const region = await Region.findById(regionKey).select('name country').lean();
  if (!region) return 'No region with that id';
  if (String(region.country) !== countryKey) {
    return `Region "${region.name}" belongs to a different country than the appellation`;
  }
  return null;
}

/**
 * Regions minted by user writes and not yet reviewed, newest first, each with
 * the wine count an admin needs to judge it (a 1-wine region is usually a
 * typo; a 30-wine one is usually real).
 */
async function listPendingRegions() {
  const [regions, counts] = await Promise.all([
    Region.find({ createdByUser: true, reviewedAt: null })
      .populate('country', 'name')
      .sort({ createdAt: -1 })
      .lean(),
    WineDefinition.aggregate([
      { $match: { region: { $ne: null } } },
      { $group: { _id: '$region', n: { $sum: 1 } } },
    ]),
  ]);
  const wineCounts = new Map(counts.map(r => [String(r._id), r.n]));
  return regions.map(r => ({
    _id: r._id,
    name: r.name,
    country: r.country?.name || null,
    countryId: r.country?._id || null,
    wineCount: wineCounts.get(String(r._id)) || 0,
    createdAt: r.createdAt,
  }));
}

/**
 * Distinct normalized appellation strings carried by wines that NO curated
 * Appellation doc (name or synonym) covers — majority display spelling and
 * majority country/region attached so promotion is one call. Tier-stripped
 * before grouping so pre-guard rows ("… DO") fold into their clean form.
 */
async function listUnmatchedAppellations() {
  const [existing, rows, skips] = await Promise.all([
    Appellation.find({}).select('normalizedName normalizedSynonyms').lean(),
    WineDefinition.aggregate([
      { $match: { appellation: { $nin: [null, ''] }, nonWine: { $ne: true }, pendingIdentity: { $ne: true } } },
      { $group: { _id: { ap: '$appellation', country: '$country', region: '$region' }, n: { $sum: 1 } } },
    ]),
    AppellationReviewSkip.find({}).select('normalizedKey').lean(),
  ]);
  const matched = new Set();
  for (const a of existing) {
    if (a.normalizedName) matched.add(a.normalizedName);
    for (const s of a.normalizedSynonyms || []) matched.add(s);
  }
  // Dismissed keys suppress exactly like curated coverage does (ticket
  // 6a842d5e): judged through candidateKeys below, so a dismissal of
  // "somewhere" also silences a later "Somewhere DO".
  const dismissed = new Set(skips.map((s) => s.normalizedKey));

  const groups = new Map();
  for (const r of rows) {
    const cleaned = normalizeAppellation(r._id.ap || '') || r._id.ap || '';
    const key = normalizeAppellationKey(cleaned);
    // Covered when ANY resolver candidate key matches, not just the exact one
    // (release-audit F2): "Yecla DO" is governed by the curated "Yecla" — the
    // resolver folds it at write time, and listing it here invites an admin to
    // promote the decorated form, whose exact-match hit would then permanently
    // beat the stripped variant and split the appellation in two. What remains
    // in this queue is only what NO variant of covers — the genuinely unknown.
    if (!key || candidateKeys(key).some((k) => matched.has(k) || dismissed.has(k))) continue;
    let g = groups.get(key);
    if (!g) { g = { spellings: new Map(), countries: new Map(), regions: new Map(), total: 0 }; groups.set(key, g); }
    g.total += r.n;
    g.spellings.set(cleaned, (g.spellings.get(cleaned) || 0) + r.n);
    if (r._id.country) g.countries.set(String(r._id.country), (g.countries.get(String(r._id.country)) || 0) + r.n);
    if (r._id.region) g.regions.set(String(r._id.region), (g.regions.get(String(r._id.region)) || 0) + r.n);
  }

  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const countryIds = new Set(), regionIds = new Set();
  const items = [...groups.entries()].map(([normalized, g]) => {
    const countryId = top(g.countries);
    const regionId = top(g.regions);
    if (countryId) countryIds.add(countryId);
    if (regionId) regionIds.add(regionId);
    return { normalized, name: top(g.spellings), wineCount: g.total, countryId, regionId };
  }).sort((a, b) => b.wineCount - a.wineCount);

  const [countries, regions] = await Promise.all([
    Country.find({ _id: { $in: [...countryIds] } }).select('name').lean(),
    Region.find({ _id: { $in: [...regionIds] } }).select('name country').lean(),
  ]);
  const countryName = new Map(countries.map(c => [String(c._id), c.name]));
  const regionById = new Map(regions.map(r => [String(r._id), r]));

  return items.map(i => {
    const region = i.regionId ? regionById.get(i.regionId) : null;
    const regionOk = region && String(region.country) === i.countryId;
    return {
      ...i,
      countryName: i.countryId ? countryName.get(i.countryId) || null : null,
      // A majority region from a DIFFERENT country than the majority country
      // would be rejected by appellationRefsError at promotion time — drop it
      // from the suggestion instead of suggesting an invalid promotion.
      regionId: regionOk ? i.regionId : null,
      regionName: regionOk ? region.name : null,
    };
  });
}

const DISMISS_REASON_MIN = 5;
const DISMISS_REASON_MAX = 500;

/**
 * The queue's group key for an appellation STRING — dismissals and the
 * listing must derive it identically or a dismissal misses its row.
 */
function unmatchedGroupKey(name) {
  const raw = String(name || '');
  const cleaned = normalizeAppellation(raw) || raw;
  return normalizeAppellationKey(cleaned);
}

/**
 * Dismiss an unmatched-appellation string: reviewed and judged NOT
 * promotable (ticket 6a842d5e — the queue's missing terminal state).
 * Suppression is by group key, so every spelling variant that folds onto it
 * goes quiet too. First dismisser wins a race ($setOnInsert, same stance as
 * the price-queue skip); the reason is the durable record of the judgement.
 *
 * @returns {{key, name, created}} or {{error}} on invalid input.
 */
async function dismissUnmatchedAppellation({ name, reason, userId }) {
  const display = stripHtml(String(name || '')).slice(0, 200).trim();
  const key = unmatchedGroupKey(display);
  if (!key) return { error: 'A non-empty appellation string is required' };
  const cleanReason = stripHtml(typeof reason === 'string' ? reason : '').trim().slice(0, DISMISS_REASON_MAX);
  if (cleanReason.length < DISMISS_REASON_MIN) {
    return { error: `A reason of at least ${DISMISS_REASON_MIN} characters is required — it is the record of why this was rejected` };
  }
  const res = await AppellationReviewSkip.findOneAndUpdate(
    { normalizedKey: key },
    { $setOnInsert: { normalizedKey: key, name: display, reason: cleanReason, skippedBy: userId, skippedAt: new Date() } },
    { upsert: true, new: false, includeResultMetadata: true }
  );
  const created = !res?.lastErrorObject?.updatedExisting;
  return { key, name: display, created };
}

/** Lift a dismissal — the string re-enters the queue while wines still carry it. */
async function restoreDismissedAppellation(name) {
  const key = unmatchedGroupKey(name);
  if (!key) return { error: 'A non-empty appellation string is required' };
  const res = await AppellationReviewSkip.deleteOne({ normalizedKey: key });
  return { key, restored: res.deletedCount > 0 };
}

/** Dismissed strings, newest first — the restorable record of what was rejected. */
async function listDismissedAppellations() {
  const rows = await AppellationReviewSkip.find({})
    .sort({ skippedAt: -1 })
    .populate('skippedBy', 'username')
    .lean();
  return rows.map((r) => ({
    key: r.normalizedKey,
    name: r.name || r.normalizedKey,
    reason: r.reason || null,
    dismissedBy: r.skippedBy?.username || null,
    dismissedAt: r.skippedAt,
  }));
}

module.exports = {
  listPendingRegions,
  listUnmatchedAppellations,
  appellationRefsError,
  dismissUnmatchedAppellation,
  restoreDismissedAppellation,
  listDismissedAppellations,
};
