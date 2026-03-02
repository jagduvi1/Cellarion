/**
 * dedup-post-import.js
 *
 * After a LWIN CSV import, backup wines (no lwin.lwin7) may be duplicated by
 * newly-created LWIN wines (has lwin.lwin7). Backup wines have composite names
 * like "Barolo Albe G.D. Vajra" while LWIN wines use short names like "Albe".
 *
 * Strategy: for each backup wine, find LWIN wines from the same producer where
 * ALL tokens of the LWIN short name appear in the backup wine's name tokens.
 * Also require same country. Keep the backup wine; delete the LWIN duplicate.
 *
 * Usage:
 *   node src/scripts/dedup-post-import.js           # dry run (shows matches)
 *   node src/scripts/dedup-post-import.js --apply   # deletes LWIN duplicates
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { normalizeString } = require('../utils/normalize');

const APPLY = process.argv.includes('--apply');

// Only truly structural/filler words — NOT wine-name terms like "reserve" or "selection"
// which are meaningful discriminators in wine names.
const NOISE_WORDS = new Set([
  'wine', 'wines', 'winery', 'vineyard', 'vineyards', 'estate', 'estates',
  'cellars', 'cellar',
  'chateau', 'domaine', 'domain', 'bodega', 'casa',
  'the', 'le', 'la', 'de', 'di', 'del', 'della', 'des', 'du',
  'and', 'et', 'y', 'e', 'und', 'a',
]);

function tokenSet(str) {
  if (!str) return new Set();
  return new Set(
    normalizeString(str)
      .split(/\s+/)
      .filter(t => t.length > 0 && !NOISE_WORDS.has(t))
  );
}

/**
 * Returns true when every token of the (shorter) LWIN name appears in the
 * backup wine's token set AND at least one of those tokens is not from the
 * producer or appellation (i.e. it's a meaningful wine-name token).
 */
function isSubsetMatch(backupNameTokens, lwinNameTokens, producerTokens, appellationTokens) {
  if (lwinNameTokens.size === 0) return false;

  // All LWIN name tokens must appear in the backup name
  for (const t of lwinNameTokens) {
    if (!backupNameTokens.has(t)) return false;
  }

  // Count tokens that are NOT from producer/appellation (novel wine-name tokens)
  const contextTokens = new Set([...producerTokens, ...appellationTokens]);
  const novelTokens = [...lwinNameTokens].filter(t => !contextTokens.has(t));

  // Require at least 2 novel tokens to avoid generic single-word matches
  // (e.g. "Riesling", "Shiraz", "Blanc" would only have 1 novel token → rejected)
  if (novelTokens.length < 2) return false;

  // LWIN name tokens must cover at least 50% of the backup name's tokens.
  // Prevents short phrases like "Brut Nature" (2 tokens) from matching a
  // long specific wine like "Blanc de Blancs Brut Nature" (5 tokens).
  if (backupNameTokens.size > 0 && lwinNameTokens.size / backupNameTokens.size < 0.6) return false;

  return true;
}

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  // Load all backup wines (no lwin.lwin7) — these are the "good" ones
  const backupWines = await WineDefinition.find(
    { 'lwin.lwin7': { $exists: false } },
    { name: 1, producer: 1, country: 1, appellation: 1, normalizedKey: 1 }
  ).lean();

  console.log(`Backup wines to check: ${backupWines.length}`);

  // Build producer → LWIN wines index for fast lookup
  // Key: normalizedProducer, Value: array of LWIN wine docs
  const lwinByProducer = new Map();

  console.log('Loading LWIN wines...');
  const cursor = WineDefinition.find(
    { 'lwin.lwin7': { $exists: true } },
    { name: 1, producer: 1, country: 1, appellation: 1, 'lwin.lwin7': 1 }
  ).lean().cursor();

  for await (const doc of cursor) {
    const key = normalizeString(doc.producer || '');
    if (!lwinByProducer.has(key)) lwinByProducer.set(key, []);
    lwinByProducer.get(key).push(doc);
  }

  console.log(`Unique LWIN producers: ${lwinByProducer.size}`);
  console.log('Scanning for duplicates...\n');

  const toDelete = [];
  let checked = 0;

  for (const bw of backupWines) {
    checked++;
    const normProducer = normalizeString(bw.producer || '');
    const candidates = lwinByProducer.get(normProducer);
    if (!candidates || candidates.length === 0) continue;

    const bwNameTokens  = tokenSet(bw.name);
    const producerTokens = tokenSet(bw.producer);
    const appellationTokens = tokenSet(bw.appellation);

    for (const lw of candidates) {
      // Must be same country
      const sameCountry = bw.country && lw.country &&
        bw.country.toString() === lw.country.toString();
      if (!sameCountry) continue;

      const lwNameTokens = tokenSet(lw.name);

      if (isSubsetMatch(bwNameTokens, lwNameTokens, producerTokens, appellationTokens)) {
        toDelete.push({ lwinId: lw._id, lwinName: lw.name, lwinKey: lw['lwin']?.lwin7, backupName: bw.name, producer: bw.producer });
        // One LWIN match per backup wine is enough
        break;
      }
    }

    if (checked % 500 === 0) process.stdout.write(`  checked ${checked}/${backupWines.length}\r`);
  }

  console.log(`\nDuplicates found: ${toDelete.length}`);

  if (toDelete.length === 0) {
    console.log('Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Show sample
  const sample = toDelete.slice(0, 20);
  console.log('\nSample matches (backup → LWIN to delete):');
  for (const d of sample) {
    console.log(`  "${d.backupName}" → DELETE "${d.lwinName}" (LWIN7: ${d.lwinKey})`);
  }
  if (toDelete.length > 20) {
    console.log(`  ... and ${toDelete.length - 20} more`);
  }

  if (!APPLY) {
    console.log('\nDry run — pass --apply to delete the LWIN duplicates.');
    await mongoose.disconnect();
    return;
  }

  console.log('\nDeleting LWIN duplicates...');
  const ids = toDelete.map(d => d.lwinId);
  const result = await WineDefinition.deleteMany({ _id: { $in: ids } });
  console.log(`Deleted ${result.deletedCount} LWIN wines.`);

  const remaining = await WineDefinition.countDocuments();
  console.log(`Wines remaining in DB: ${remaining}`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
