/**
 * backfill-maturity-profiles.js
 *
 * One-off backfill: for every (wineDefinition, vintage) pair that has at least
 * one bottle but no corresponding WineVintageProfile, create a pending profile
 * so the wine+vintage appears in the somm maturity queue.
 *
 * This is the general superset of backfill-nv-profiles.js: it covers EVERY
 * non-"Unknown" vintage (year vintages AND NV), not just NV. Run it once after
 * deploying the fix that seeds the queue from imports — wines imported BEFORE
 * that fix (especially ones added via a "request" later approved by an admin)
 * have bottles with a wineDefinition but no pending profile, so they never
 * surfaced for a somm. "Unknown" is skipped (no calendar year to recommend a
 * window for), matching utils/vintageProfile.ensurePendingVintageProfile.
 *
 * Behaviour:
 *   - DRY-RUN by default: prints what would be created, changes nothing.
 *   - Pass --apply to actually write the profiles.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/backfill-maturity-profiles.js          # dry run
 *   docker exec cellarion-backend node src/scripts/backfill-maturity-profiles.js --apply
 *
 * Or locally (requires .env):
 *   cd backend && node src/scripts/backfill-maturity-profiles.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineVintageProfile = require('../models/WineVintageProfile');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
require('../models/Country');
require('../models/Region');
require('../models/Grape');
require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

const key = (wineDefinition, vintage) => `${wineDefinition}:${vintage}`;

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');
  console.log(APPLY ? 'Mode: APPLY (profiles will be written)' : 'Mode: DRY RUN (no changes)');
  console.log('');

  // Distinct (wineDefinition, vintage) pairs across all bottles linked to a real
  // wine (not a pendingWineRequest) with a usable vintage.
  const pairs = await Bottle.aggregate([
    { $match: { wineDefinition: { $ne: null }, vintage: { $nin: ['Unknown', null, ''] } } },
    { $group: { _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' } } },
  ]);
  console.log(`Distinct wine+vintage pairs with bottles:  ${pairs.length}`);

  // Existing profiles (any status) → the set we must NOT recreate.
  const existing = await WineVintageProfile.find({}, 'wineDefinition vintage').lean();
  const have = new Set(existing.map(p => key(p.wineDefinition, p.vintage)));
  console.log(`  already have a profile:                  ${have.size}`);

  const missing = pairs
    .map(p => ({ wineDefinition: p._id.wineDefinition, vintage: p._id.vintage }))
    .filter(p => !have.has(key(p.wineDefinition, p.vintage)));
  console.log(`  missing a profile (to backfill):         ${missing.length}`);

  if (missing.length === 0) {
    console.log('\nNothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Sample up to 10 for context.
  const sampleIds = [...new Set(missing.slice(0, 10).map(m => m.wineDefinition))];
  const sampleWines = await WineDefinition.find({ _id: { $in: sampleIds } }, 'name producer').lean();
  const nameById = new Map(sampleWines.map(w => [w._id.toString(), w]));
  console.log('  sample pairs that will get a profile:');
  for (const m of missing.slice(0, 10)) {
    const w = nameById.get(m.wineDefinition.toString());
    console.log(`    ${w?.producer || '?'} — ${w?.name || '?'} (${m.vintage})`);
  }
  if (missing.length > 10) {
    console.log(`    … and ${missing.length - 10} more`);
  }

  if (APPLY) {
    const docs = missing.map(m => ({
      wineDefinition: m.wineDefinition,
      vintage: m.vintage,
      status: 'pending',
      // Derived, same as ensurePendingVintageProfile — seeding it false shipped
      // NV rows into the queue self-contradictory (ticket d49d2b36).
      relative: m.vintage === 'NV',
    }));
    // ordered:false so a single duplicate-key error (race with a live add/import)
    // doesn't abort the whole batch.
    const result = await WineVintageProfile.insertMany(docs, { ordered: false }).catch(err => {
      if (err.insertedDocs) return err.insertedDocs;
      throw err;
    });
    const insertedCount = Array.isArray(result) ? result.length : (result?.insertedCount ?? 0);
    console.log(`\n  → inserted ${insertedCount} pending profiles`);
  } else {
    console.log('\n  (dry run — no profiles inserted)');
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
