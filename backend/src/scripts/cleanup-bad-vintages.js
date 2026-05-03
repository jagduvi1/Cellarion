/**
 * cleanup-bad-vintages.js
 *
 * One-off cleanup for WineVintageProfile and Bottle records whose `vintage`
 * value falls outside the validated range (e.g. typos like "1001" that
 * predate the validation added in the same change).
 *
 * Behaviour:
 *   - DRY-RUN by default: prints what would be touched, changes nothing.
 *   - Pass --apply to actually write changes.
 *   - Pass --fix-bottles to also rewrite affected Bottle.vintage values to
 *     "NV". Without this flag, bottles are reported but left alone — only
 *     the orphan WineVintageProfile records are deleted.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/cleanup-bad-vintages.js          # dry run
 *   docker exec cellarion-backend node src/scripts/cleanup-bad-vintages.js --apply  # delete profiles
 *   docker exec cellarion-backend node src/scripts/cleanup-bad-vintages.js --apply --fix-bottles
 *
 * Or locally (requires .env):
 *   cd backend && node src/scripts/cleanup-bad-vintages.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineVintageProfile = require('../models/WineVintageProfile');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
// Register schemas referenced via populate so Mongoose doesn't complain
require('../models/Country');
require('../models/Region');
require('../models/Grape');
require('../models/User');
const { parseAndValidateVintage } = require('../utils/validation');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const FIX_BOTTLES = args.has('--fix-bottles');

function isBadVintage(v) {
  return !parseAndValidateVintage(v).ok;
}

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');
  console.log(APPLY ? 'Mode: APPLY (changes will be written)' : 'Mode: DRY RUN (no changes)');
  if (FIX_BOTTLES) console.log('Mode: also rewriting bad Bottle.vintage to "NV"');
  console.log('');

  // ── Phase 1: WineVintageProfile records ─────────────────────────────────
  const profiles = await WineVintageProfile.find({}, 'vintage wineDefinition status').lean();
  const badProfiles = profiles.filter(p => isBadVintage(p.vintage));

  console.log(`WineVintageProfile total:    ${profiles.length}`);
  console.log(`  with bad vintages:         ${badProfiles.length}`);

  if (badProfiles.length > 0) {
    // Show what we found, grouped by vintage value
    const byVintage = new Map();
    for (const p of badProfiles) {
      byVintage.set(p.vintage, (byVintage.get(p.vintage) || 0) + 1);
    }
    console.log('  breakdown by vintage:');
    for (const [v, count] of [...byVintage.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    "${v}": ${count}`);
    }

    // Sample up to 10 affected wines for context
    const sampleIds = badProfiles.slice(0, 10).map(p => p.wineDefinition);
    const sampleWines = await WineDefinition.find({ _id: { $in: sampleIds } }, 'name producer').lean();
    const wineById = new Map(sampleWines.map(w => [w._id.toString(), w]));
    console.log('  sample affected wines:');
    for (const p of badProfiles.slice(0, 10)) {
      const w = wineById.get(p.wineDefinition.toString());
      const label = w ? `${w.producer || '?'} — ${w.name || '?'}` : '(wine not found)';
      console.log(`    [vintage="${p.vintage}", status=${p.status}] ${label}`);
    }
    if (badProfiles.length > 10) {
      console.log(`    … and ${badProfiles.length - 10} more`);
    }

    if (APPLY) {
      const ids = badProfiles.map(p => p._id);
      const result = await WineVintageProfile.deleteMany({ _id: { $in: ids } });
      console.log(`  → deleted ${result.deletedCount} profiles`);
    } else {
      console.log('  (dry run — no profiles deleted)');
    }
  }

  // ── Phase 2: Bottle records ─────────────────────────────────────────────
  console.log('');
  // Pull only candidate fields. We can't easily filter bad vintages in Mongo
  // because the rule is regex+range; a $not/$regex would miss edge cases.
  const allBottleVintages = await Bottle.find({}, 'vintage').lean();
  const badBottles = allBottleVintages.filter(b => isBadVintage(b.vintage));

  console.log(`Bottle total:                ${allBottleVintages.length}`);
  console.log(`  with bad vintages:         ${badBottles.length}`);

  if (badBottles.length > 0) {
    const byVintage = new Map();
    for (const b of badBottles) byVintage.set(b.vintage, (byVintage.get(b.vintage) || 0) + 1);
    console.log('  breakdown by vintage:');
    for (const [v, count] of [...byVintage.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    "${v}": ${count}`);
    }

    if (APPLY && FIX_BOTTLES) {
      const ids = badBottles.map(b => b._id);
      const result = await Bottle.updateMany(
        { _id: { $in: ids } },
        { $set: { vintage: 'NV' } }
      );
      console.log(`  → rewrote ${result.modifiedCount} bottle vintages to "NV"`);
    } else if (APPLY) {
      console.log('  (--fix-bottles not passed — bottles left alone)');
    } else {
      console.log('  (dry run — no bottles updated)');
    }
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
