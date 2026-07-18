/**
 * seed-taxonomy-descriptions-2026-07.js
 *
 * Loads the rich, original markdown descriptions for grapes, countries and
 * regions from src/data/taxonomy-descriptions/*.json and writes them onto the
 * matching taxonomy documents. These replace the earlier plain-prose
 * descriptions with consistent, structured markdown (rendered on the public
 * /grapes, /regions, /countries pages and served to AI via the MCP
 * describe_* tools).
 *
 * Content was written for this project (not copied from any source) and
 * fact-checked; see the generating workflow in the 2026-07-18 taxonomy work.
 *
 * Matching:
 *   grapes    → Grape by normalizedName
 *   countries → Country by normalizedName
 *   regions   → Country by normalizedName, then Region by {country, normalizedName}
 *               (region names repeat across countries, so the country is part
 *                of the key — the data file carries it)
 *
 * By default OVERWRITES the description (the whole point is the richer text),
 * except the PRESERVE set below (hand-curated home-market entries). Re-running
 * is idempotent. Unmatched names are reported, never created.
 *
 * Usage:
 *   node src/scripts/seed-taxonomy-descriptions-2026-07.js           # dry run
 *   node src/scripts/seed-taxonomy-descriptions-2026-07.js --apply   # execute
 */

require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const { normalizeString } = require('../utils/normalize');

const APPLY = process.argv.includes('--apply');
const DATA = path.join(__dirname, '..', 'data', 'taxonomy-descriptions');

// Hand-curated entries left untouched (Johan's Swedish home-market prose).
// Keyed by "<kind>:<normalizedName>".
const PRESERVE = new Set(['country:sweden', 'region:skane', 'region:norrland']);

const grapes = require(path.join(DATA, 'grapes.json'));
const countries = require(path.join(DATA, 'countries.json'));
const regions = require(path.join(DATA, 'regions.json'));

const stats = { set: 0, same: 0, preserved: 0, missing: 0 };
const tag = APPLY ? '✔' : '[dry]';

async function seedGrapes() {
  console.log(`== Grapes (${grapes.length}) ==`);
  for (const item of grapes) {
    if (PRESERVE.has(`grape:${normalizeString(item.name)}`)) { stats.preserved += 1; continue; }
    const doc = await Grape.findOne({ normalizedName: normalizeString(item.name) });
    if (!doc) { stats.missing += 1; console.log(`  – not in DB: ${item.name}`); continue; }
    if (doc.description === item.description) { stats.same += 1; continue; }
    stats.set += 1;
    console.log(`${tag} grape "${item.name}" (${(doc.description || '').length} → ${item.description.length} chars)`);
    if (APPLY) { doc.description = item.description; await doc.save(); }
  }
}

async function seedCountries() {
  console.log(`\n== Countries (${countries.length}) ==`);
  for (const item of countries) {
    if (PRESERVE.has(`country:${normalizeString(item.name)}`)) { stats.preserved += 1; console.log(`  ~ preserved: ${item.name}`); continue; }
    const doc = await Country.findOne({ normalizedName: normalizeString(item.name) });
    if (!doc) { stats.missing += 1; console.log(`  – not in DB: ${item.name}`); continue; }
    if (doc.description === item.description) { stats.same += 1; continue; }
    stats.set += 1;
    console.log(`${tag} country "${item.name}" (${(doc.description || '').length} → ${item.description.length} chars)`);
    if (APPLY) { doc.description = item.description; await doc.save(); }
  }
}

async function seedRegions() {
  console.log(`\n== Regions (${regions.length}) ==`);
  const countryCache = new Map();
  const resolveCountry = async (name) => {
    const key = normalizeString(name || '');
    if (countryCache.has(key)) return countryCache.get(key);
    const c = await Country.findOne({ normalizedName: key }).select('_id').lean();
    countryCache.set(key, c);
    return c;
  };
  for (const item of regions) {
    if (PRESERVE.has(`region:${normalizeString(item.name)}`)) { stats.preserved += 1; console.log(`  ~ preserved: ${item.name}`); continue; }
    const country = await resolveCountry(item.country);
    if (!country) { stats.missing += 1; console.log(`  – country not in DB: ${item.country} (for region ${item.name})`); continue; }
    const doc = await Region.findOne({ country: country._id, normalizedName: normalizeString(item.name) });
    if (!doc) { stats.missing += 1; console.log(`  – not in DB: ${item.name} (${item.country})`); continue; }
    if (doc.description === item.description) { stats.same += 1; continue; }
    stats.set += 1;
    console.log(`${tag} region "${item.name}" [${item.country}] (${(doc.description || '').length} → ${item.description.length} chars)`);
    if (APPLY) { doc.description = item.description; await doc.save(); }
  }
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);
  await seedGrapes();
  await seedCountries();
  await seedRegions();
  console.log(`\nSummary: ${stats.set} updated, ${stats.same} already current, ${stats.preserved} preserved, ${stats.missing} not found in DB.`);
  console.log('Note: taxonomy LIST pages cache for up to 10 min; detail pages + MCP describe_* tools reflect changes immediately.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
