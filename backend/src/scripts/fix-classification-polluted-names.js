/**
 * fix-classification-polluted-names.js
 *
 * Ticket 6a83f014: registry wines whose `name` holds an appellation or a
 * Bordeaux classed-growth phrase instead of the wine's name ("Grand Cru
 * Classé de Graves" — Château Pape Clément; "Margaux" — Château du Tertre).
 * Prevention now lives in findOrCreateWine.unpolluteEstateName (the mint
 * chokepoint); this applies the SAME shared guard to existing rows, so the
 * backfill and the mint rule cannot drift.
 *
 * Per changed row: name/appellation/classification shift per the guard, the
 * normalizedKey and canonicalKey regenerate (name and appellation feed both
 * dedup keys), updatedAt moves, the name-check and cross-field clearances are
 * dropped, and Meili reindexes.
 * A collision on the new key (a correctly-named twin already in the registry)
 * is SKIPPED and reported for manual merge — this script never merges wines.
 *
 * Dry-run by default; --apply appends each row's old values to an NDJSON
 * backup before writing it (scripts/lib/backupLog: --backup-dir=<dir> or
 * SCRIPT_BACKUP_DIR, default the OS temp dir).
 *
 * Usage:
 *   node src/scripts/fix-classification-polluted-names.js            # dry run
 *   node src/scripts/fix-classification-polluted-names.js --apply
 *   node src/scripts/fix-classification-polluted-names.js --apply --backup-dir=<dir>
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { unpolluteEstateName } = require('../services/findOrCreateWine');
const { generateWineKey } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');
const searchService = require('../services/search');
const { initSearch } = require('./lib/scriptSearch');
const { createBackupLog } = require('./lib/backupLog');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

// Rows whose normalizedKey is a generateWineKey key. A pending-identity row
// keys as `pending~<creator>` and a draft as `draft~<creator>`: re-keyed here
// they would enter the public key space while still private. A canary keeps
// the fields it was seeded with.
const CANDIDATES = {
  nonWine: { $ne: true },
  producer: { $nin: [null, ''] },
  pendingIdentity: { $ne: true },
  draft: { $ne: true },
  canary: { $ne: true },
};

// updateOne bypasses WineDefinition's pre-validate hook, so this update does
// what the hook does when a save changes name and appellation:
// - canonicalKey: findOrCreateWine looks it up first, and a key still built
//   from the polluted name misses this row and mints a twin.
// - verifiedChecks / crossChecksCleared: an admin cleared those rules against
//   the old strings; they no longer vouch for the new ones.
// - updatedAt: the Registry Bridge change check reads it, so adopted copies
//   receive the rename.
function buildFixUpdate(w, out, newKey) {
  return {
    $set: {
      name: out.name,
      appellation: out.appellation || null,
      classification: out.classification || null,
      normalizedKey: newKey,
      canonicalKey: computeCanonicalKey(out.name, w.producer, out.appellation),
      verifiedAt: null,
      crossChecksClearedAt: null,
      updatedAt: new Date(),
    },
    $unset: { verifiedChecks: '', crossChecksCleared: '' },
  };
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);
  const searchOk = APPLY ? await initSearch({ label: 'fix-classification-polluted-names' }) : false;

  const wines = await WineDefinition
    .find(CANDIDATES)
    .select('name producer appellation classification normalizedKey canonicalKey verifiedChecks verifiedAt crossChecksCleared crossChecksClearedAt')
    .lean();

  const stats = { scanned: 0, changed: 0, collisions: 0, byShape: {} };
  const backup = createBackupLog('polluted-names');

  for (const w of wines) {
    stats.scanned += 1;
    const out = await unpolluteEstateName({
      name: w.name, producer: w.producer,
      appellation: w.appellation || null, classification: w.classification || null,
    });
    if (!out.changed) continue;

    const newKey = generateWineKey(out.name, w.producer, out.appellation || '');
    const clash = await WineDefinition.findOne({ normalizedKey: newKey, _id: { $ne: w._id } }).select('_id name').lean();
    if (clash) {
      stats.collisions += 1;
      console.log(`  ⚠ collision (manual merge): "${w.name}" — ${w.producer} → key of ${clash._id} ("${clash.name}")`);
      continue;
    }

    stats.changed += 1;
    stats.byShape[out.changed] = (stats.byShape[out.changed] || 0) + 1;
    console.log(`${tag} [${out.changed}] "${w.name}" — ${w.producer}`);
    console.log(`      → name "${out.name}" · appellation "${out.appellation || '∅'}" · classification "${out.classification || '∅'}"`);

    if (APPLY) {
      backup.append({
        _id: String(w._id), name: w.name, appellation: w.appellation || null, classification: w.classification || null,
        normalizedKey: w.normalizedKey, canonicalKey: w.canonicalKey ?? null,
        verifiedChecks: w.verifiedChecks ?? null, verifiedAt: w.verifiedAt ?? null,
        crossChecksCleared: w.crossChecksCleared ?? null, crossChecksClearedAt: w.crossChecksClearedAt ?? null,
      });
      await WineDefinition.updateOne({ _id: w._id }, buildFixUpdate(w, out, newKey));
      if (searchOk) await searchService.indexWine(w._id);
    }
  }

  if (APPLY) backup.report();

  console.log(`\nSummary: ${stats.scanned} scanned, ${stats.changed} ${APPLY ? 'fixed' : 'would change'} ` +
    `(${Object.entries(stats.byShape).map(([s, n]) => `${s}: ${n}`).join(', ') || 'none'}), ` +
    `${stats.collisions} collisions left for manual merge.`);
  if (APPLY) console.log(`Next: the changed rows re-key${searchOk ? ' + reindexed inline' : ' (not reindexed: Meilisearch unavailable)'}; run an incremental embed if descriptions exist for them.`);
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => { console.error('Fix polluted names failed:', err); process.exit(1); });
}

module.exports = { CANDIDATES, buildFixUpdate };
