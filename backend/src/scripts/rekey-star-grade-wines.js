/**
 * Re-key the registry wines whose NAME carries a star grade.
 *
 * Wine names used to be keyed with every '*' stripped, so "Auslese**" and
 * "Auslese***" (two of Markus Molitor's wines) built one dedup key. A name's
 * star grade is now a word ("***" → "3star", utils/normalize
 * normalizeWineName); keys stored before that change still carry the stripped
 * form, and a lookup by the new key would miss them. This brings normalizedKey
 * and canonicalKey up to date for exactly those wines.
 *
 * Runs at every boot (server.js) and is idempotent: once the keys are current
 * it finds nothing to do. Also runnable by hand:
 *
 *   docker exec cellarion-backend node src/scripts/rekey-star-grade-wines.js           (dry run)
 *   docker exec cellarion-backend node src/scripts/rekey-star-grade-wines.js --apply
 *
 * Narrow on purpose. normalizedKey is rewritten only when the stored key is
 * exactly the star-stripped form of the wine's current fields, so the grade is
 * the only thing that changes, and never onto a key another wine (or an
 * earlier row of this run) holds. canonicalKey is non-unique and derived from
 * the fields alone, so it is recomputed whenever it differs.
 */

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { normalizeString, normalizeWineName, PENDING_KEY_PREFIX, DRAFT_KEY_PREFIX } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

// The key a wine's fields build, in its own namespace, with `nameNorm` for the
// name segment (producer and appellation are never graded). Pending
// (producerless, per creator) and draft (private, per creator) keys keep their
// head segment.
function keyFor(w, nameNorm) {
  const head = String(w.normalizedKey || '').split(':')[0];
  const name = nameNorm(w.name || '');
  const appellation = normalizeString(w.appellation || '');
  if (head.startsWith(PENDING_KEY_PREFIX)) return `${head}:${name}:${appellation}`;
  if (head.startsWith(DRAFT_KEY_PREFIX)) return `${head}:${normalizeString(w.producer || '')}:${name}:${appellation}`;
  return `${normalizeString(w.producer || '')}:${name}:${appellation}`;
}

async function run({ apply }) {
  // A STRING pattern, so JavaScript turns ★ into the ★ itself: a RegExp
  // literal reaches MongoDB as its source text, and the server's PCRE2
  // rejects the \u escape ("Regular expression is invalid") — the whole run
  // failed on every boot (release audit 2026-10-13, caught on prod data).
  const wines = await WineDefinition.find({ name: { $regex: '[*★]' } })
    .select('name producer appellation normalizedKey canonicalKey')
    .lean();

  const report = { found: wines.length, rekeyed: [], canonical: [], skipped: [], failed: [] };
  const claimed = new Set();
  for (const w of wines) {
    const label = `${w.producer} — ${w.name} [${w._id}]`;
    try {
      const set = {};
      const newKey = keyFor(w, normalizeWineName);
      if (w.normalizedKey !== newKey) {
        if (w.normalizedKey !== keyFor(w, normalizeString)) {
          report.skipped.push(`${label}: stored key "${w.normalizedKey}" is not the star-stripped form of its fields — left for a curator`);
        } else if (claimed.has(newKey) || await WineDefinition.exists({ normalizedKey: newKey, _id: { $ne: w._id } })) {
          report.skipped.push(`${label}: new key "${newKey}" is already taken`);
        } else {
          set.normalizedKey = newKey;
          claimed.add(newKey);
          report.rekeyed.push(`${label}: "${w.normalizedKey}" → "${newKey}"`);
        }
      }
      const canonicalKey = computeCanonicalKey(w.name, w.producer, w.appellation);
      if (w.canonicalKey !== canonicalKey) {
        set.canonicalKey = canonicalKey;
        report.canonical.push(label);
      }
      if (apply && Object.keys(set).length > 0) {
        await WineDefinition.updateOne({ _id: w._id }, { $set: set });
      }
    } catch (err) {
      report.failed.push(`${label}: ${err.message}`);
    }
  }
  return report;
}

if (require.main === module) {
  (async () => {
    const apply = process.argv.includes('--apply');
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
    const report = await run({ apply });
    console.log(`[rekey-star-grade-wines] ${apply ? 'APPLY' : 'DRY-RUN'} found=${report.found} rekeyed=${report.rekeyed.length} canonical=${report.canonical.length} skipped=${report.skipped.length} failed=${report.failed.length}`);
    for (const line of report.rekeyed) console.log(`  ${apply ? 'rekeyed' : 'would rekey'}: ${line}`);
    for (const line of report.canonical) console.log(`  ${apply ? 'canonicalKey set' : 'would set canonicalKey'}: ${line}`);
    for (const line of report.skipped) console.log(`  skipped: ${line}`);
    for (const line of report.failed) console.log(`  failed: ${line}`);
    await mongoose.disconnect();
  })().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
}

module.exports = { run, keyFor };
