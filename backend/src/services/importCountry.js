/**
 * The country of an import row whose file states none, read from what the
 * registry already knows. A wine cannot be stored without a country
 * (models/WineDefinition), so without this such a row can only become a wine
 * request. Never a guess: each source answers only when it names exactly ONE
 * country, and the first source that answers wins.
 *
 *   1. the appellation taxonomy   "Barolo" is in Italy;
 *   2. the region taxonomy        "Mosel" is in Germany. Only regions a
 *                                 curator reviewed or seeded: one a member's
 *                                 own add created is that member's reading;
 *   3. the registry's own wines   every published wine of this producer is in
 *                                 one country, and there are at least two:
 *                                 one wine is one earlier file's word.
 *
 * A name two countries share (a "Monterrei" in each of two countries, a
 * producer bottling on two continents) derives nothing.
 */
const Appellation = require('../models/Appellation');
const Region = require('../models/Region');
const Country = require('../models/Country');
const WineDefinition = require('../models/WineDefinition');
const { normalizeString, normalizeAppellationKey, isIdentitySentinel } = require('../utils/normalize');
const { logger } = require('./audit');

// A producer's country is read from its published wines only when there are
// this many: a single wine may itself have come from one member's file.
const MIN_PRODUCER_WINES = 2;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The one country these docs agree on, as an id string, or null. */
function soleCountry(docs) {
  const ids = new Set(docs.map((d) => (d.country ? String(d.country) : '')).filter(Boolean));
  return ids.size === 1 ? [...ids][0] : null;
}

async function fromAppellation(appellation) {
  const key = normalizeAppellationKey(appellation || '');
  if (!key) return null;
  const docs = await Appellation.find({ $or: [{ normalizedName: key }, { normalizedSynonyms: key }] })
    .select('country').limit(5).lean();
  return soleCountry(docs);
}

async function fromRegion(region) {
  const key = normalizeString(region || '');
  if (!key) return null;
  const docs = await Region.find({
    $and: [
      { $or: [{ normalizedName: key }, { normalizedSynonyms: key }] },
      { $or: [{ createdByUser: { $ne: true } }, { reviewedAt: { $ne: null } }] },
    ],
  }).select('country').limit(5).lean();
  return soleCountry(docs);
}

async function fromProducer(producer) {
  if (!producer || isIdentitySentinel(producer)) return null;
  const key = normalizeString(producer);
  if (!key) return null;
  // An anchored prefix on the unique normalizedKey index, as
  // services/importMatching.splitKnownProducerPrefix reads it. The pending,
  // draft and unchecked namespaces never start with a producer, so only
  // published wines answer.
  const filter = {
    normalizedKey: new RegExp(`^${escapeRegex(key)}:`),
    nonWine: { $ne: true },
    pendingIdentity: { $ne: true },
  };
  const ids = await WineDefinition.distinct('country', filter);
  if (ids.length !== 1) return null;
  const wines = await WineDefinition.countDocuments(filter, { limit: MIN_PRODUCER_WINES });
  return wines >= MIN_PRODUCER_WINES ? String(ids[0]) : null;
}

/**
 * Derive the country NAME for a row from its appellation, its region or its
 * producer, in that order; null when none of them settles it. Never throws: a
 * lookup failure derives nothing, and the row takes the path a countryless
 * row always took. Called by routes/import.js /validate for a row identified
 * from the file alone.
 *
 * @param {{appellation?: string, region?: string, producer?: string}} row
 * @returns {Promise<string|null>}
 */
async function deriveCountryName({ appellation, region, producer } = {}) {
  try {
    const id = await fromAppellation(appellation) || await fromRegion(region) || await fromProducer(producer);
    if (!id) return null;
    const country = await Country.findById(id).select('name').lean();
    return country?.name || null;
  } catch (err) {
    logger.warn({ err: err.message }, '[importCountry] lookup failed, no country derived');
    return null;
  }
}

/**
 * Fill in the country of a file-stated identity (services/importIdentity
 * fileStatedIdentity) that has none. The identity is returned as it came when
 * it has a country, when it is null, or when nothing settles one. Called by
 * routes/import.js /validate, once per distinct wine of the file.
 *
 * @param {object|null} identity
 * @returns {Promise<object|null>}
 */
async function withDerivedCountry(identity) {
  if (!identity || identity.country) return identity;
  const country = await deriveCountryName(identity);
  return country ? { ...identity, country } : identity;
}

module.exports = { deriveCountryName, withDerivedCountry };
