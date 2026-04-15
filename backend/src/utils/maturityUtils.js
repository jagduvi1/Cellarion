/**
 * Maturity classification utilities — shared by statsService and aiChat.
 */

const WineVintageProfile = require('../models/WineVintageProfile');

/**
 * Classify a bottle's maturity status using the sommelier WineVintageProfile.
 * Returns one of: 'declining', 'late', 'peak', 'early', 'not-ready', or null.
 */
function classifyMaturity(bottle, profileMap) {
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

  const profiles = await WineVintageProfile.find({ $or: profileQueries, status: 'reviewed' }).lean();
  for (const p of profiles) {
    map.set(`${p.wineDefinition.toString()}:${p.vintage}`, p);
  }
  return map;
}

/**
 * Return a human-readable maturity label for the chat context.
 * Uses the classification status and the profile's year ranges.
 *
 * @param {string|null} status  – output of classifyMaturity()
 * @param {object|null} profile – the WineVintageProfile document
 * @returns {string|null}
 */
function maturityLabel(status, profile) {
  if (!status) return null;
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

module.exports = { classifyMaturity, buildProfileMap, maturityLabel };
