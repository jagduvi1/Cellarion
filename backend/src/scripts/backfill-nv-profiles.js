/**
 * backfill-nv-profiles.js
 *
 * One-off backfill: for every WineDefinition that has at least one bottle
 * with vintage="NV" but no corresponding pending/reviewed
 * WineVintageProfile, create a pending NV profile so the wine appears in
 * the somm maturity queue.
 *
 * Behaviour:
 *   - DRY-RUN by default: prints what would be created, changes nothing.
 *   - Pass --apply to actually write the profiles.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/backfill-nv-profiles.js          # dry run
 *   docker exec cellarion-backend node src/scripts/backfill-nv-profiles.js --apply
 *
 * Or locally (requires .env):
 *   cd backend && node src/scripts/backfill-nv-profiles.js
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

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');
  console.log(APPLY ? 'Mode: APPLY (profiles will be written)' : 'Mode: DRY RUN (no changes)');
  console.log('');

  // Wines that have at least one NV bottle (linked to a real wineDefinition,
  // not a pendingWineRequest)
  const wineIdsWithNvBottles = await Bottle.distinct('wineDefinition', {
    vintage: 'NV',
    wineDefinition: { $ne: null }
  });
  console.log(`Wines with NV bottles:                 ${wineIdsWithNvBottles.length}`);

  // Of those, which already have an NV profile?
  const existingNvProfiles = await WineVintageProfile.find(
    { wineDefinition: { $in: wineIdsWithNvBottles }, vintage: 'NV' },
    'wineDefinition'
  ).lean();
  const haveProfile = new Set(existingNvProfiles.map(p => p.wineDefinition.toString()));
  console.log(`  already have NV profile:             ${haveProfile.size}`);

  const missing = wineIdsWithNvBottles.filter(id => !haveProfile.has(id.toString()));
  console.log(`  missing NV profile (to backfill):    ${missing.length}`);

  if (missing.length === 0) {
    console.log('\nNothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Sample up to 10 wines for context
  const sample = await WineDefinition.find(
    { _id: { $in: missing.slice(0, 10) } },
    'name producer'
  ).lean();
  console.log('  sample wines that will get a profile:');
  for (const w of sample) {
    console.log(`    ${w.producer || '?'} — ${w.name || '?'}`);
  }
  if (missing.length > 10) {
    console.log(`    … and ${missing.length - 10} more`);
  }

  if (APPLY) {
    const docs = missing.map(wineDefinition => ({
      wineDefinition,
      vintage: 'NV',
      status: 'pending'
    }));
    // ordered:false so a single duplicate-key error (race with the route)
    // doesn't abort the whole batch
    const result = await WineVintageProfile.insertMany(docs, { ordered: false }).catch(err => {
      // insertMany throws on any failure; with ordered:false it still inserts
      // the rest. Surface the result that's attached to the error.
      if (err.insertedDocs) return err.insertedDocs;
      throw err;
    });
    const insertedCount = Array.isArray(result) ? result.length : (result?.insertedCount ?? 0);
    console.log(`\n  → inserted ${insertedCount} pending NV profiles`);
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
