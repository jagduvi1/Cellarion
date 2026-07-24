/**
 * normalize-appellation-tiers.js
 *
 * Ticket #2C: the same appellation is stored both with and without its
 * classification tier ("Barolo" vs "Barolo DOCG"), fragmenting it in any
 * appellation-grouped view. The write paths now canonicalize on create
 * (utils/normalize.normalizeAppellation), so this cleans up existing rows.
 *
 * For each wine whose appellation carries a strippable tier, it computes the
 * canonical appellation (place name) and the new normalizedKey (appellation is
 * part of the dedup key). Because normalizedKey is UNIQUE:
 *   - no collision → update appellation + normalizedKey, re-index Meili.
 *   - collision (another wine already has the canonical key: a genuine
 *     same-producer+name duplicate) → SKIP and report it for manual merge via
 *     the admin duplicate-clusters UI. This script never merges wines.
 *
 * generateWineSlug uses name+producer only, so the public /wines/:slug URL is
 * unaffected; bottles carry no denormalized appellation.
 *
 * Dry-run by default. On --apply: writes a JSON backup of affected rows first.
 * Run the admin embedding job afterwards (appellation feeds the embed text).
 *
 * Usage:
 *   node src/scripts/normalize-appellation-tiers.js            # dry run
 *   node src/scripts/normalize-appellation-tiers.js --apply    # execute
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { normalizeAppellation, generateWineKey } = require('../utils/normalize');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const wines = await WineDefinition
    .find({ appellation: { $nin: [null, ''] } })
    .select('name producer appellation normalizedKey')
    .lean();

  const stats = { scanned: 0, changed: 0, same: 0, collisions: 0 };
  const backup = [];
  let shown = 0;

  for (const w of wines) {
    stats.scanned += 1;
    const canonical = normalizeAppellation(w.appellation);
    if (canonical === w.appellation) { stats.same += 1; continue; }

    const newKey = generateWineKey(w.name, w.producer, canonical || '');
    // A different wine already occupying the canonical key = a real duplicate.
    const clash = await WineDefinition.findOne({ normalizedKey: newKey, _id: { $ne: w._id } }).select('_id').lean();
    if (clash) {
      stats.collisions += 1;
      console.log(`  ⚠ collision (manual merge): "${w.name}" — ${w.producer} | "${w.appellation}" → "${canonical}" clashes with ${clash._id}`);
      continue;
    }

    stats.changed += 1;
    if (shown < 40) {
      console.log(`${tag} "${w.name}" — ${w.producer}:  "${w.appellation}"  →  "${canonical}"`);
      shown += 1;
    }
    backup.push({ _id: String(w._id), appellation: w.appellation, normalizedKey: w.normalizedKey });

    if (APPLY) {
      await WineDefinition.updateOne({ _id: w._id }, { $set: { appellation: canonical || null, normalizedKey: newKey } });
      try { await require('../services/search').indexWine(w._id); } catch { /* best-effort */ }
    }
  }

  if (APPLY && backup.length) {
    const file = path.join(os.tmpdir(), `appellation-tiers-backup-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\nBackup of ${backup.length} rows → ${file}`);
  }

  console.log(`\nSummary: ${stats.scanned} wines with an appellation, ${stats.changed} ${APPLY ? 'canonicalized' : 'would change'}, ${stats.same} already canonical, ${stats.collisions} collisions left for manual merge.`);
  if (APPLY) console.log('Next: run the admin embedding job (appellation feeds the embed text); the appellation field + grouping update now.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Appellation cleanup failed:', err); process.exit(1); });
