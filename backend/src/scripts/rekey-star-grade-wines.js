/**
 * Re-key the registry wines whose identity carries a star grade.
 *
 * normalizeString used to strip '*' with the rest of the punctuation, so
 * "Auslese**" and "Auslese***" (two of Markus Molitor's wines) built one dedup
 * key. It now turns a run of stars into a grade word ("***" → "3star"); the
 * keys stored before that change still carry the stripped form, and a lookup
 * by the new key would miss them. This brings normalizedKey and canonicalKey
 * up to date for exactly those wines.
 *
 * Narrow on purpose: a wine is re-keyed only when its stored normalizedKey is
 * what the OLD normalization builds from its current fields, so the only thing
 * that changes is the star grade. Anything else (a key built from older field
 * values, a collision with another wine) is reported and left alone.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   docker exec cellarion-backend node src/scripts/rekey-star-grade-wines.js
 *   docker exec cellarion-backend node src/scripts/rekey-star-grade-wines.js --apply
 */

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { normalizeString, generateWineKey, PENDING_KEY_PREFIX, DRAFT_KEY_PREFIX } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

// normalizeString as it was before star grades became words.
const legacyNormalize = (str) => (!str ? '' : str
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^\w\s]/g, '')
  .replace(/\s+/g, ' ')
  .trim());

// The key a wine's fields build, in its own namespace: pending (producerless,
// per creator) and draft (private, per creator) keys keep their head segment.
function keyFor(w, norm) {
  const head = String(w.normalizedKey || '').split(':')[0];
  if (head.startsWith(PENDING_KEY_PREFIX)) return `${head}:${norm(w.name)}:${norm(w.appellation || '')}`;
  if (head.startsWith(DRAFT_KEY_PREFIX)) return `${head}:${norm(w.producer || '')}:${norm(w.name)}:${norm(w.appellation || '')}`;
  return norm === normalizeString
    ? generateWineKey(w.name, w.producer, w.appellation || '')
    : `${norm(w.producer)}:${norm(w.name)}:${norm(w.appellation || '')}`;
}

async function run({ apply }) {
  const wines = await WineDefinition.find({
    $or: [{ name: /[*★]/ }, { producer: /[*★]/ }, { appellation: /[*★]/ }],
  }).select('name producer appellation normalizedKey canonicalKey').lean();

  const report = { found: wines.length, rekeyed: [], skipped: [] };
  for (const w of wines) {
    const label = `${w.producer} — ${w.name} [${w._id}]`;
    const newKey = keyFor(w, normalizeString);
    const canonicalKey = computeCanonicalKey(w.name, w.producer, w.appellation);
    if (w.normalizedKey === newKey && w.canonicalKey === canonicalKey) { report.skipped.push(`${label}: already current`); continue; }
    if (w.normalizedKey !== keyFor(w, legacyNormalize)) {
      report.skipped.push(`${label}: stored key "${w.normalizedKey}" is not the star-stripped form of its fields — left for a curator`);
      continue;
    }
    const clash = await WineDefinition.findOne({ normalizedKey: newKey, _id: { $ne: w._id } }).select('_id').lean();
    if (clash) { report.skipped.push(`${label}: new key "${newKey}" is taken by ${clash._id}`); continue; }
    if (apply) {
      await WineDefinition.updateOne({ _id: w._id }, { $set: { normalizedKey: newKey, canonicalKey } });
    }
    report.rekeyed.push(`${label}: "${w.normalizedKey}" → "${newKey}"`);
  }
  return report;
}

if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
    const report = await run({ apply });
    console.log(`[rekey-star-grade-wines] ${apply ? 'APPLY' : 'DRY-RUN'} found=${report.found} rekeyed=${report.rekeyed.length} skipped=${report.skipped.length}`);
    for (const line of report.rekeyed) console.log(`  ${apply ? 'rekeyed' : 'would rekey'}: ${line}`);
    for (const line of report.skipped) console.log(`  skipped: ${line}`);
    await mongoose.disconnect();
  })().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
}

module.exports = { run, keyFor, legacyNormalize };
