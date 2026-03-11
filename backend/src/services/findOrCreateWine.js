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
const { generateWineKey, normalizeString, resolveGrapeName, combinedSimilarity } = require('../utils/normalize');

const SIMILARITY_THRESHOLD = 0.75;
const POPULATE = ['country', 'region', 'grapes'];

// ── Taxonomy helpers ─────────────────────────────────────────────────────────

async function findOrCreateCountry(name, userId) {
  if (!name || !name.trim()) return null;
  const normalizedName = normalizeString(name);
  let country = await Country.findOne({ normalizedName });
  if (country) return country;
  country = new Country({ name: name.trim(), normalizedName, createdBy: userId });
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

// ── Similarity scoring ───────────────────────────────────────────────────────

function scoreCandidates(name, producer, appellation, candidates) {
  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const nameSim = combinedSimilarity(name, candidate.name);
    const prodSim = combinedSimilarity(producer, candidate.producer);

    let appSim = 1.0;
    if (appellation && candidate.appellation) {
      appSim = combinedSimilarity(appellation, candidate.appellation);
    } else if (appellation || candidate.appellation) {
      // One side has appellation, other doesn't — slight penalty
      appSim = 0.5;
    }

    const score = nameSim * 0.45 + prodSim * 0.45 + appSim * 0.10;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return { bestMatch, bestScore };
}

// ── Main find-or-create ──────────────────────────────────────────────────────

/**
 * Find an existing WineDefinition or create a new one.
 *
 * @param {Object} wineData   - { name, producer, country, region, appellation, type, grapes[] }
 * @param {string} userId     - ObjectId string of the authenticated user (for createdBy)
 * @returns {{ wine: WineDefinition, created: boolean }}
 */
async function findOrCreateWine({ name, producer, country, region, appellation, type, grapes }, userId) {
  const trimmedName = name.trim();
  const trimmedProducer = producer.trim();

  // 1. Exact match by normalizedKey
  const normalizedKey = generateWineKey(trimmedName, trimmedProducer, appellation);
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
    const { bestMatch, bestScore } = scoreCandidates(trimmedName, trimmedProducer, appellation, candidates);
    if (bestScore >= SIMILARITY_THRESHOLD && bestMatch) {
      return { wine: bestMatch, created: false };
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
    appellation: appellation?.trim() || null,
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
