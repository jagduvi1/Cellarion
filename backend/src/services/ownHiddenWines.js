/**
 * A member's OWN quarantined drinks (2026-10-13).
 *
 * The non-wine quarantine hides a row from registry search for everyone: the
 * shared registry is for wine. But a member who keeps cider, beer or soda in
 * Cellarion still has to find THEIR drink to add another bottle, and the
 * search box — the first thing anyone tries — came back empty. Typing the
 * producer and name exactly, scanning the label or the barcode all reached the
 * hidden row (exact-key resolution matches it on purpose); searching did not.
 *
 * So a search also looks among the quarantined rows the caller created or holds
 * a bottle of (any status: a drunk bottle is the "buy it again" case). Nobody
 * else's search ever returns them, and the rows stay out of the shared index.
 */
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { normalizeString } = require('../utils/normalize');
const { escapeRegex } = require('../utils/sanitize');

const MAX_TOKENS = 6;
// Quarantined rows matching the words, before the ownership check. The
// quarantine holds dozens of rows, not thousands; this only bounds a very
// short query against a future larger one.
const CANDIDATE_CAP = 50;
const DEFAULT_LIMIT = 5;

/**
 * Every word of the search must appear in the wine's key (producer, name and
 * appellation, normalized the same way the key is), in any order.
 */
function termFilter(term) {
  const tokens = normalizeString(String(term || '')).split(' ').filter(Boolean).slice(0, MAX_TOKENS);
  if (!tokens.length) return null;
  return { $and: tokens.map((tok) => ({ normalizedKey: { $regex: escapeRegex(tok) } })) };
}

/**
 * Ids of the caller's own quarantined rows that match a search.
 *
 * @param {string} userId
 * @param {string} term
 * @param {{limit?: number}} [opts]
 * @returns {Promise<string[]>}
 */
async function findOwnHiddenWineIds(userId, term, { limit = DEFAULT_LIMIT } = {}) {
  if (!userId) return [];
  const match = termFilter(term);
  if (!match) return [];
  const candidates = await WineDefinition.find({ nonWine: true, canary: { $ne: true }, ...match })
    .select('_id createdBy').limit(CANDIDATE_CAP).lean();
  if (!candidates.length) return [];

  const uid = String(userId);
  const created = candidates.filter((c) => String(c.createdBy) === uid).map((c) => String(c._id));
  const held = (await Bottle.distinct('wineDefinition', {
    user: userId, wineDefinition: { $in: candidates.map((c) => c._id) },
  })).map(String);
  return [...new Set([...created, ...held])].slice(0, limit);
}

/**
 * Is this a quarantined row the caller created or holds a bottle of? For reads
 * by id that otherwise refuse quarantined rows.
 */
async function isOwnHiddenWine(userId, wineId) {
  if (!userId || !wineId) return false;
  const wine = await WineDefinition.findOne({ _id: wineId, nonWine: true }).select('createdBy').lean();
  if (!wine) return false;
  if (String(wine.createdBy) === String(userId)) return true;
  return !!(await Bottle.exists({ user: userId, wineDefinition: wineId }));
}

module.exports = { findOwnHiddenWineIds, isOwnHiddenWine };
