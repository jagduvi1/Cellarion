/**
 * Maturity classification utilities — shared by statsService and aiChat.
 */

const WineVintageProfile = require('../models/WineVintageProfile');

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
  if (!wdId || !vintage || vintage === 'NV') return null;

  const profile = profileMap.get(`${wdId}:${vintage}`);
  if (!profile || profile.status !== 'reviewed') return null;

  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = profile;

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
    if (wdId && v && v !== 'NV') {
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

  switch (status) {
    case 'not-ready':
      return `Not ready yet — drinking from ${profile?.earlyFrom || profile?.peakFrom || '?'}`;
    case 'early':
      return profile?.peakFrom
        ? `Early drinking — peak from ${profile.peakFrom}`
        : 'Early drinking window';
    case 'peak':
      return profile?.peakUntil
        ? `At peak — drink now through ${profile.peakUntil}`
        : 'At peak maturity — drink now';
    case 'late':
      return profile?.lateUntil
        ? `Late maturity — drink soon, until ${profile.lateUntil}`
        : 'Late maturity — drink soon';
    case 'declining':
      return 'Past peak — declining, drink immediately if at all';
    default:
      return null;
  }
}

module.exports = { classifyMaturity, classifyPersonalWindow, buildProfileMap, maturityLabel };
