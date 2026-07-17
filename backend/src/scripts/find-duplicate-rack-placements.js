/**
 * find-duplicate-rack-placements — pre-flight for the unique slots.bottle index.
 *
 * The Rack model declares a unique multikey index on slots.bottle (prior-audit
 * M4: one slot per bottle, enforced across racks). Mongo can only BUILD that
 * index if no bottle currently sits in two racks — historical races or bugs
 * could have left such rows, in which case the index build fails on boot
 * (mongoose logs it and the app keeps running WITHOUT the protection).
 *
 * This script lists every bottle placed in more than one active rack, with the
 * racks/cellars involved, so the stray placement can be removed by hand (or by
 * simply re-placing the bottle once — placeBottleInRack clears other racks).
 *
 * Run inside the backend container (read-only; changes nothing):
 *   docker exec cellarion-backend node src/scripts/find-duplicate-rack-placements.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  const Rack = require('../models/Rack');

  const dups = await Rack.aggregate([
    { $match: { deletedAt: null } },
    { $unwind: '$slots' },
    {
      $group: {
        _id: '$slots.bottle',
        count: { $sum: 1 },
        racks: { $push: { rack: '$_id', name: '$name', cellar: '$cellar', position: '$slots.position' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (dups.length === 0) {
    console.log('OK: no bottle is placed in more than one rack — the unique slots.bottle index can build.');
  } else {
    console.log(`Found ${dups.length} bottle(s) placed in multiple racks (the unique index will NOT build until fixed):`);
    for (const d of dups) {
      console.log(`\n  bottle ${d._id}:`);
      for (const r of d.racks) {
        console.log(`    - rack "${r.name}" (${r.rack}) cellar ${r.cellar} position ${r.position}`);
      }
    }
    console.log('\nFix: re-place each bottle once in the UI (placement clears other racks), or $pull the stray slots entry.');
    process.exitCode = 1;
  }

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(2); });
