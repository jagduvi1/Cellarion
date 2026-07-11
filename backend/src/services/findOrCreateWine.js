/**
 * findOrCreateWine service
 *
 * Resolves a wine definition from AI-extracted label data:
 *   1. Exact match by normalizedKey (producer:name:appellation)
 *   2. Fuzzy similarity search using Meilisearch + scoring
 *   3. If no match above threshold: create wine + any missing taxonomy records
 *
 * Taxonomy helpers (findOrCreateCountry, findOrCreateRegion, findOrCreateGrapes)
 * use find-by-normalizedName before inserting to prevent duplicates.
 */

const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const searchService = require('./search');
const { generateWineKey, normalizeString, resolveGrapeName, resolveCountryName } = require('../utils/normalize');
const { scoreAllMatches } = require('./wineMatching');

// Auto-match when combined score >= SIMILARITY_THRESHOLD (near-identical — e.g.
// token-order or punctuation differences the exact normalizedKey match missed).
// In the SOFT_ZONE_MIN..SIMILARITY_THRESHOLD band, surface candidates to the
// user ("did you mean one of these?") instead of silently creating a new wine.
// Below SOFT_ZONE_MIN the wines aren't close enough to be worth asking, so we
// just create. The soft-zone floor is deliberately high: a "did you mean?"
// prompt for a loose match (e.g. a Brut vs a Blanc de Blancs at ~50%) is noise.
const SIMILARITY_THRESHOLD = 0.95;
const SOFT_ZONE_MIN = 0.85;
const SOFT_ZONE_TOP_N = 5;
const POPULATE = ['country', 'region', 'grapes'];

// ── Taxonomy helpers ─────────────────────────────────────────────────────────

async function findOrCreateCountry(name, userId) {
  if (!name || !name.trim()) return null;
  // Resolve alias → canonical name before lookup (e.g. "USA" → "United States",
  // "Tyskland" → "Germany") so localized/abbreviated AI output can't mint a
  // duplicate Country — mirrors the resolveGrapeName pattern below.
  const canonicalName = resolveCountryName(name);
  const normalizedName = normalizeString(canonicalName);
  let country = await Country.findOne({ normalizedName });
  if (country) return country;
  country = new Country({ name: canonicalName.trim(), normalizedName, createdBy: userId });
  await country.save();
  return country;
}

async function findOrCreateRegion(name, countryId, userId) {
  if (!name || !name.trim() || !countryId) return null;
  const normalizedName = normalizeString(name);
  let region = await Region.findOne({ country: countryId, normalizedName });
  if (region) return region;
  region = new Region({ name: name.trim(), normalizedName, country: countryId, createdBy: userId });
  await region.save();
  return region;
}

async function findOrCreateGrapes(names, userId) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const ids = [];
  const seen = new Set(); // deduplicate within the same call (e.g. AI returns "Shiraz" + "Syrah")
  for (const name of names) {
    if (!name || !name.trim()) continue;
    // Resolve synonym → canonical name before lookup (e.g. "Shiraz" → "Syrah")
    const canonicalName = resolveGrapeName(name);
    const normalizedName = normalizeString(canonicalName);
    if (seen.has(normalizedName)) continue; // skip intra-call duplicates
    seen.add(normalizedName);
    let grape = await Grape.findOne({ normalizedName });
    if (!grape) {
      grape = new Grape({ name: canonicalName, normalizedName, createdBy: userId });
      await grape.save();
    }
    ids.push(grape._id);
  }
  return ids;
}

// ── Main find-or-create ──────────────────────────────────────────────────────

/**
 * Find an existing WineDefinition or create a new one.
 *
 * Three return shapes:
 *   { wine, created: false }                   — exact or auto-fuzzy match (>= SIMILARITY_THRESHOLD)
 *   { wine: null, candidates: [...] }          — soft zone: similar wines exist but not enough to auto-match.
 *                                                Caller (UI) should show a "did you mean?" prompt.
 *   { wine, created: true }                    — no match, new wine created
 *
 * Pass `confirmCreate: true` to bypass the soft-zone gate and force creation
 * — used when the user has explicitly confirmed "no, none of those, make a new one".
 *
 * @param {Object} wineData   - { name, producer, country, region, appellation, type, grapes[] }
 * @param {string} userId     - ObjectId string of the authenticated user (for createdBy)
 * @param {Object} [opts]
 * @param {boolean} [opts.confirmCreate=false] - Skip soft-zone candidate return and create directly
 */
async function findOrCreateWine({ name, producer, country, region, appellation, type, grapes }, userId, { confirmCreate = false } = {}) {
  // Cap stored/compared field lengths at this single create chokepoint (covers
  // the find-or-create route, CSV import, and label-scan). This bounds both the
  // fuzzy-match cost and the persisted document size WITHOUT a schema maxlength
  // validator — a validator re-runs on every .save() (full-document validation)
  // and would make legacy rows that predate the cap un-editable.
  const MAX_FIELD = 200;
  const trimmedName = name.trim().slice(0, MAX_FIELD);
  const trimmedProducer = producer.trim().slice(0, MAX_FIELD);
  const trimmedAppellation = (typeof appellation === 'string' ? appellation.trim() : '').slice(0, MAX_FIELD);

  // 1. Exact match by normalizedKey
  const normalizedKey = generateWineKey(trimmedName, trimmedProducer, trimmedAppellation);
  let wine = await WineDefinition.findOne({ normalizedKey }).populate(POPULATE);
  if (wine) return { wine, created: false };

  // 2. Fuzzy similarity search
  const searchQuery = `${trimmedName} ${trimmedProducer}`.trim();
  let candidates = [];

  if (searchService.getIsAvailable()) {
    try {
      const { ids } = await searchService.search(searchQuery, { limit: 20 });
      if (ids.length > 0) {
        candidates = await WineDefinition.find({ _id: { $in: ids } }).populate(POPULATE);
      }
    } catch (err) {
      console.warn('Meilisearch unavailable in findOrCreateWine:', err.message);
    }
  }

  // MongoDB text-search fallback
  if (candidates.length === 0) {
    try {
      candidates = await WineDefinition.find({ $text: { $search: searchQuery } })
        .populate(POPULATE)
        .limit(20);
    } catch {
      // No text-index match — proceed to creation
    }
  }

  if (candidates.length > 0) {
    const ranked = scoreAllMatches(
      { name: trimmedName, producer: trimmedProducer, appellation: trimmedAppellation },
      candidates,
      { redistribute: false }
    );

    // Auto-match: top score is confident enough
    if (ranked[0].score >= SIMILARITY_THRESHOLD) {
      return { wine: ranked[0].wine, created: false };
    }

    // Soft zone: top score is suggestive but not confident. Surface up to N
    // candidates and let the user choose, unless the caller has already
    // confirmed they want to create regardless.
    if (!confirmCreate && ranked[0].score >= SOFT_ZONE_MIN) {
      const softCandidates = ranked
        .filter(r => r.score >= SOFT_ZONE_MIN)
        .slice(0, SOFT_ZONE_TOP_N)
        .map(r => ({ wine: r.wine, score: Math.round(r.score * 100) / 100 }));
      return { wine: null, candidates: softCandidates };
    }
  }

  // 3. Create new wine — resolve taxonomy first
  const countryDoc = await findOrCreateCountry(country, userId);
  if (!countryDoc) {
    const err = new Error('Country is required to create a wine');
    err.status = 400;
    throw err;
  }

  const regionDoc = await findOrCreateRegion(region, countryDoc._id, userId);
  const grapeIds = await findOrCreateGrapes(grapes, userId);

  const validTypes = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
  const wineType = validTypes.includes(type) ? type : 'red';

  const newWine = new WineDefinition({
    name: trimmedName,
    producer: trimmedProducer,
    country: countryDoc._id,
    region: regionDoc?._id || null,
    appellation: trimmedAppellation || null,
    type: wineType,
    grapes: grapeIds,
    normalizedKey,
    createdBy: userId
  });

  try {
    await newWine.save();
  } catch (err) {
    if (err.code === 11000) {
      // Race condition: another request created the same wine concurrently
      wine = await WineDefinition.findOne({ normalizedKey }).populate(POPULATE);
      return { wine, created: false };
    }
    throw err;
  }

  await newWine.populate(POPULATE);

  // Sync to Meilisearch (fire-and-forget)
  searchService.indexWine(newWine._id);

  return { wine: newWine, created: true };
}

module.exports = { findOrCreateWine, findOrCreateCountry, findOrCreateRegion, findOrCreateGrapes };
