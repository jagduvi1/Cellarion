/**
 * Carry `pendingReview` across to the two fields that replaced it (2026-08-31).
 *
 * The old boolean conflated two facts: that a user write minted the document,
 * and that nobody had reviewed it. Every row still carrying `pendingReview:
 * true` means BOTH — so it becomes `createdByUser: true` with `reviewedAt`
 * left null. Rows where an admin had already approved (pendingReview false or
 * absent) carry no origin information at all: the old approve DELETED it. That
 * is unrecoverable, so those rows are left with createdByUser absent rather
 * than guessed either way — absent means "not recorded", which is true.
 *
 *   node src/scripts/migrate-taxonomy-provenance.js            # dry run
 *   node src/scripts/migrate-taxonomy-provenance.js --apply
 */
const mongoose = require('mongoose');
const Region = require('../models/Region');
const Grape = require('../models/Grape');

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  for (const [label, Model] of [['regions', Region], ['grapes', Grape]]) {
    const coll = Model.collection;
    const toMigrate = await coll.countDocuments({ pendingReview: true });
    const alreadyDone = await coll.countDocuments({ createdByUser: true });
    console.log(`${label}: pendingReview=true -> ${toMigrate}   already createdByUser=true -> ${alreadyDone}`);
    if (!APPLY) continue;
    const set = await coll.updateMany(
      { pendingReview: true },
      { $set: { createdByUser: true, reviewedAt: null, reviewedBy: null } }
    );
    // Drop the retired field everywhere, including the approved rows whose
    // origin the old verb had already erased.
    const unset = await coll.updateMany({ pendingReview: { $exists: true } }, { $unset: { pendingReview: '' } });
    console.log(`  set createdByUser on ${set.modifiedCount}; removed pendingReview from ${unset.modifiedCount}`);
    console.log(`  now: createdByUser=true -> ${await coll.countDocuments({ createdByUser: true })}, ` +
      `stale pendingReview -> ${await coll.countDocuments({ pendingReview: { $exists: true } })}`);
  }
  if (!APPLY) console.log('=== DRY RUN ===');
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
