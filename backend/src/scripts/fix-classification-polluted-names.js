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
 * Dry-run by default; --apply writes a JSON backup of affected rows first.
 *
 * Usage:
 *   node src/scripts/fix-classification-polluted-names.js            # dry run
 *   node src/scripts/fix-classification-polluted-names.js --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { unpolluteEstateName } = require('../services/findOrCreateWine');
const { generateWineKey } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

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

  const wines = await WineDefinition
    .find({ nonWine: { $ne: true }, producer: { $nin: [null, ''] } })
    .select('name producer appellation classification normalizedKey canonicalKey verifiedChecks verifiedAt crossChecksCleared crossChecksClearedAt')
    .lean();

  const stats = { scanned: 0, changed: 0, collisions: 0, byShape: {} };
  const backup = [];

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
    backup.push({
      _id: String(w._id), name: w.name, appellation: w.appellation || null, classification: w.classification || null,
      normalizedKey: w.normalizedKey, canonicalKey: w.canonicalKey ?? null,
      verifiedChecks: w.verifiedChecks ?? null, verifiedAt: w.verifiedAt ?? null,
      crossChecksCleared: w.crossChecksCleared ?? null, crossChecksClearedAt: w.crossChecksClearedAt ?? null,
    });

    if (APPLY) {
      await WineDefinition.updateOne({ _id: w._id }, buildFixUpdate(w, out, newKey));
      try { await require('../services/search').indexWine(w._id); } catch { /* best-effort */ }
    }
  }

  if (APPLY && backup.length) {
    const file = path.join(os.tmpdir(), `polluted-names-backup-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\nBackup of ${backup.length} rows → ${file} (container /tmp is ephemeral — copy it off)`);
  }

  console.log(`\nSummary: ${stats.scanned} scanned, ${stats.changed} ${APPLY ? 'fixed' : 'would change'} ` +
    `(${Object.entries(stats.byShape).map(([s, n]) => `${s}: ${n}`).join(', ') || 'none'}), ` +
    `${stats.collisions} collisions left for manual merge.`);
  if (APPLY) console.log('Next: the changed rows re-key + reindexed inline; run an incremental embed if descriptions exist for them.');
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => { console.error('Fix polluted names failed:', err); process.exit(1); });
}

module.exports = { buildFixUpdate };
