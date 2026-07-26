/**
 * strip-name-vintages.js
 *
 * Registry audit 2026-07-26 (B2): 19 wines carry a trailing vintage year in
 * their NAME ("Reserve Cabernet Sauvignon 2023") even though the registry is
 * vintage-neutral by construction — the year belongs on Bottle.vintage. The
 * write paths now strip it on create (utils/normalize.stripTrailingVintage,
 * wired into findOrCreateWine step 0); this cleans up existing rows.
 *
 * For each wine whose name ends in a plausible vintage (1950–2049, TRAILING
 * only — leading years are brand names like "1924 Double Black"):
 *   - compute the stripped name and the new normalizedKey (name is part of
 *     the dedup key). Because normalizedKey is UNIQUE:
 *       no collision → update name + normalizedKey, re-index Meili (wine AND
 *       its bottles — bottle documents denormalize wineName);
 *       collision → SKIP and report for manual merge (the year was the only
 *       thing distinguishing two rows = a genuine duplicate).
 *   - write the stripped year to Bottle.vintage for the wine's bottles, but
 *     ONLY where bottle.vintage is null — an owner's explicit vintage is
 *     never overwritten, even when it disagrees with the name.
 *
 * The wine's slug is deliberately untouched (URL stability — same rule as
 * every rename path). Embedding: the name feeds the embed text, so touched
 * wines re-embed on the next incremental job run; start one after --apply.
 *
 * Dry-run by default. On --apply: writes a JSON backup of affected rows first.
 *
 * Usage:
 *   node src/scripts/strip-name-vintages.js            # dry run
 *   node src/scripts/strip-name-vintages.js --apply    # execute
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const searchService = require('../services/search');
const { stripTrailingVintage, generateWineKey } = require('../utils/normalize');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const wines = await WineDefinition
    .find({ name: { $regex: /(?:19[5-9]\d|20[0-4]\d)\)?$/ } })
    .select('name producer appellation normalizedKey')
    .lean();

  const stats = { candidates: 0, changed: 0, collisions: 0, bottlesDated: 0 };
  const backup = [];

  for (const w of wines) {
    const stripped = stripTrailingVintage(w.name);
    if (stripped === w.name) continue; // name IS just a year, or no real match
    stats.candidates += 1;

    // The year that was removed — what the owners' undated bottles receive.
    const yearMatch = w.name.match(/(19[5-9]\d|20[0-4]\d)/g);
    const year = yearMatch ? parseInt(yearMatch[yearMatch.length - 1], 10) : null;

    const newKey = generateWineKey(stripped, w.producer, w.appellation || '');
    const clash = await WineDefinition.findOne({ normalizedKey: newKey, _id: { $ne: w._id } }).select('_id name').lean();
    if (clash) {
      stats.collisions += 1;
      console.log(`  SKIP (collision) "${w.name}" — ${w.producer} [${w._id}] → would collide with [${clash._id}] "${clash.name}"; merge via the admin duplicates tool instead`);
      continue;
    }

    const undated = await Bottle.countDocuments({ wineDefinition: w._id, vintage: null });
    console.log(`  ${tag} "${w.name}" → "${stripped}"  (year ${year} → ${undated} undated bottle(s))  [${w._id}]`);

    if (APPLY) {
      backup.push(w);
      await WineDefinition.updateOne(
        { _id: w._id },
        { $set: { name: stripped, normalizedKey: newKey, updatedAt: new Date() } }
      );
      if (year && undated > 0) {
        const r = await Bottle.updateMany(
          { wineDefinition: w._id, vintage: null },
          { $set: { vintage: year } }
        );
        stats.bottlesDated += r.modifiedCount || 0;
      }
      searchService.indexWine(w._id);
      const bottleIds = await Bottle.distinct('_id', { wineDefinition: w._id });
      if (bottleIds.length) {
        searchService.bulkIndexBottles(bottleIds).catch(() => {});
      }
    }
    stats.changed += 1;
  }

  if (APPLY && backup.length) {
    const file = path.join(os.tmpdir(), `strip-name-vintages-backup-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 1));
    console.log(`\nBackup of ${backup.length} pre-change rows: ${file}`);
    console.log('(container /tmp is ephemeral — docker cp it off before recreating the container)');
  }

  console.log(`\nCandidates: ${stats.candidates}  changed: ${stats.changed}  collisions(skipped): ${stats.collisions}  bottles dated: ${stats.bottlesDated}`);
  if (APPLY) console.log('Next: start the admin embedding job (incremental) — the name feeds the embed text.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('strip-name-vintages failed:', err); process.exit(1); });
