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
 * normalizedKey regenerates (name feeds the dedup key), and Meili reindexes.
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

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const wines = await WineDefinition
    .find({ nonWine: { $ne: true }, producer: { $nin: [null, ''] } })
    .select('name producer appellation classification normalizedKey')
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
    backup.push({ _id: String(w._id), name: w.name, appellation: w.appellation || null, classification: w.classification || null, normalizedKey: w.normalizedKey });

    if (APPLY) {
      await WineDefinition.updateOne(
        { _id: w._id },
        { $set: {
          name: out.name,
          appellation: out.appellation || null,
          classification: out.classification || null,
          normalizedKey: newKey,
        } }
      );
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

run().catch((err) => { console.error('Fix polluted names failed:', err); process.exit(1); });
