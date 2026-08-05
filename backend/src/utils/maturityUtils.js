/**
 * Maturity classification utilities — shared by statsService and aiChat.
 */

const WineVintageProfile = require('../models/WineVintageProfile');

const WINDOW_FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];

/**
 * The year a relative (NV) window is measured from for a given bottle: its
 * purchase year, falling back to when it was added to the cellar. Mirrors
 * frontend/src/utils/maturityUtils.js bottleAnchorYear — the two must not
 * drift or the bottle page and the backend stats/notifier disagree.
 */
function bottleAnchorYear(bottle) {
  const d = bottle?.purchaseDate || bottle?.createdAt;
  if (!d) return null;
  // UTC year, not local: date-only purchase dates ("2026-12-31") parse as UTC
  // midnight, so a local-time read shifts Dec-31/Jan-1 purchases into the
  // wrong year in non-UTC timezones (a Dec 31 purchase read in a UTC+13
  // browser becomes next year while the UTC server keeps this year). The UTC
  // year is always the calendar year the user picked, in every timezone.
  const y = new Date(d).getUTCFullYear();
  return Number.isFinite(y) ? y : null;
}

/**
 * Resolve a profile's drink window to absolute calendar years.
 *
 * For `relative` profiles (NV / non-vintage wines) the stored numbers are
 * year-offsets after the bottle's anchor year, so we add the anchor; otherwise
 * the numbers are already absolute years and the anchor is ignored. Mirrors
 * the frontend resolveWindow.
 */
function resolveWindow(profile, anchorYear) {
  const rel = !!(profile?.relative) && Number.isFinite(anchorYear);
  const out = {};
  for (const f of WINDOW_FIELDS) {
    const v = profile?.[f];
    out[f] = (v === null || v === undefined) ? v : (rel ? v + anchorYear : v);
  }
  return out;
}

/**
 * Resolve a profile's window against a specific bottle: absolute years pass
 * through; relative (NV) offsets are anchored on the bottle's purchase year.
 * Returns null when a relative window has no anchor to resolve against (e.g.
 * a caller that selected the bottle without purchaseDate/createdAt) — raw
 * offsets must never be read as calendar years.
 */
function resolveWindowForBottle(profile, bottle) {
  if (!profile) return null;
  if (!profile.relative) return resolveWindow(profile, null);
  const anchorYear = bottleAnchorYear(bottle);
  if (anchorYear === null) return null;
  return resolveWindow(profile, anchorYear);
}

/**
 * Classify a bottle against its OWN drinkFrom/drinkTo window (optional integer
 * years the user set on the bottle). Returns 'not-ready' | 'peak' | 'declining'
 * or null when the bottle has no personal window. A single-bound window is
 * open-ended on the missing side.
 */
function classifyPersonalWindow(bottle, currentYear = new Date().getFullYear()) {
  const from = Number.isFinite(bottle?.drinkFrom) ? bottle.drinkFrom : null;
  const to   = Number.isFinite(bottle?.drinkTo)   ? bottle.drinkTo   : null;
  if (from === null && to === null) return null;
  if (from !== null && currentYear < from) return 'not-ready';
  if (to   !== null && currentYear > to)   return 'declining';
  return 'peak';
}

/**
 * Classify a bottle's maturity status using the sommelier WineVintageProfile.
 * A personal per-bottle window (bottle.drinkFrom/drinkTo) takes precedence
 * over the vintage-profile window when set.
 * Returns one of: 'declining', 'late', 'peak', 'early', 'not-ready', or null.
 */
function classifyMaturity(bottle, profileMap) {
  // The user's own drink window always wins over the shared profile — and
  // applies even to NV bottles or bottles without a wine definition.
  const personal = classifyPersonalWindow(bottle);
  if (personal) return personal;

  const wdId    = bottle.wineDefinition?._id?.toString() || bottle.wineDefinition?.toString();
  const vintage = bottle.vintage;
  if (!wdId || !vintage) return null;

  const profile = profileMap.get(`${wdId}:${vintage}`);
  if (!profile || profile.status !== 'reviewed') return null;

  // NV bottles carry `relative` profiles whose numbers are offsets after the
  // purchase year — resolved here, same as the frontend, so NV maturity is no
  // longer invisible server-side. Null when the offsets can't be anchored.
  const window = resolveWindowForBottle(profile, bottle);
  if (!window) return null;

  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = window;

  // Need at least one window boundary to classify
  if (!earlyFrom && !peakFrom && !peakUntil) return null;

  const currentYear = new Date().getFullYear();

  // Before the earliest defined window → not ready
  const firstYear = earlyFrom || peakFrom;
  if (firstYear && currentYear < firstYear) return 'not-ready';

  if (earlyUntil && currentYear <= earlyUntil) return 'early';
  if (peakFrom && currentYear < peakFrom) return 'early';
  if (peakUntil && currentYear <= peakUntil) return 'peak';
  if (lateFrom && currentYear < lateFrom) return 'peak';
  if (lateUntil && currentYear <= lateUntil) return 'late';
  if ((lateUntil && currentYear > lateUntil) ||
      (peakUntil && currentYear > peakUntil && !lateFrom)) return 'declining';
  if (peakFrom && currentYear >= peakFrom) return 'peak';
  return 'early';
}

/** Build and return a WineVintageProfile lookup map for a set of active bottles. */
async function buildProfileMap(activeBottles) {
  const seenPairs = new Set();
  const profileQueries = [];
  for (const b of activeBottles) {
    const wdId = b.wineDefinition?._id?.toString();
    const v    = b.vintage;
    // 'NV' is a valid key — sommeliers curate `relative` profiles for
    // non-vintage wines, resolved per bottle by classifyMaturity.
    if (wdId && v) {
      const key = `${wdId}:${v}`;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        profileQueries.push({ wineDefinition: wdId, vintage: v });
      }
    }
  }
  const map = new Map();
  if (profileQueries.length === 0) return map;

  // One index-friendly $in over wineDefinition instead of an N-branch $or (which
  // can reach thousands of clauses on a large maturity-sorted cellar), then drop
  // rows whose (wineDefinition, vintage) pair wasn't requested. Same
  // {wineDefinition, vintage} unique index, one query.
  const wineIds = [...new Set(profileQueries.map(q => q.wineDefinition))];
  const profiles = await WineVintageProfile.find({
    wineDefinition: { $in: wineIds },
    status: 'reviewed',
  }).lean();
  for (const p of profiles) {
    const key = `${p.wineDefinition.toString()}:${p.vintage}`;
    if (seenPairs.has(key)) map.set(key, p);
  }
  return map;
}

/**
 * Return a human-readable maturity label for the chat context.
 *
 * Uses the classification status and year ranges. When the bottle's PERSONAL
 * drink window governs the status (same precedence as classifyMaturity), the
 * label quotes the personal drinkFrom/drinkTo years — NOT the sommelier
 * profile's — so the years match the status source (otherwise a personal
 * "not-ready" could read "drinking from 2020" while the real personal drinkFrom
 * is 2035). With no personal window, the profile-based labels are unchanged.
 *
 * @param {string|null} status  – output of classifyMaturity()
 * @param {object|null} profile – the WineVintageProfile document
 * @param {object|null} bottle  – the bottle (for its personal drinkFrom/drinkTo)
 * @returns {string|null}
 */
function maturityLabel(status, profile, bottle = null) {
  if (!status) return null;

  // Personal window wins: build the label from the user's own years so it is
  // consistent with the personal-window status classifyMaturity returned.
  if (bottle && classifyPersonalWindow(bottle)) {
    const from = Number.isFinite(bottle.drinkFrom) ? bottle.drinkFrom : null;
    const to   = Number.isFinite(bottle.drinkTo)   ? bottle.drinkTo   : null;
    switch (status) {
      case 'not-ready':
        return `Not ready yet — drinking from ${from ?? '?'}`;
      case 'peak':
        return to ? `At peak — drink now through ${to}` : 'At peak maturity — drink now';
      case 'declining':
        return 'Past peak — declining, drink immediately if at all';
      default:
        break; // any other status → fall through to the profile-based labels
    }
  }

  // Quote resolved calendar years, never raw relative (NV) offsets. A
  // relative profile with no anchor yields no years ('?' / generic labels) —
  // the same bottles classifyMaturity leaves unclassified anyway.
  const w = (profile?.relative ? resolveWindowForBottle(profile, bottle) : profile) || {};

  switch (status) {
    case 'not-ready':
      return `Not ready yet — drinking from ${w.earlyFrom || w.peakFrom || '?'}`;
    case 'early':
      return w.peakFrom
        ? `Early drinking — peak from ${w.peakFrom}`
        : 'Early drinking window';
    case 'peak':
      return w.peakUntil
        ? `At peak — drink now through ${w.peakUntil}`
        : 'At peak maturity — drink now';
    case 'late':
      return w.lateUntil
        ? `Late maturity — drink soon, until ${w.lateUntil}`
        : 'Late maturity — drink soon';
    case 'declining':
      return 'Past peak — declining, drink immediately if at all';
    default:
      return null;
  }
}

module.exports = {
  classifyMaturity, classifyPersonalWindow, buildProfileMap, maturityLabel,
  bottleAnchorYear, resolveWindow, resolveWindowForBottle,
};
