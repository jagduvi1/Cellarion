/**
 * Remove ALL bottles belonging to one user — for cleaning out test data
 * (e.g. the admin account's trial bottles), without touching the user's
 * account, cellars or racks themselves.
 *
 * Each bottle goes through the app's own delete cascade
 * (services/bottleOps.removeBottleCascade, what DELETE /api/bottles/:id runs),
 * so nothing here can drift from the app:
 *  - frees its rack slot
 *  - deletes the user's own photos with their files and thumbnails — a file
 *    another photo still uses is kept
 *  - keeps registry photos (the wine's picture, or any photo approved as
 *    public — services/photoRetention), only detached from the bottle
 *  - withdraws a pending import request once no bottle waits on it
 *  - writes one 'bottle.delete' audit row per bottle (actor: system)
 * Then the user's "Recently deleted" is emptied the way the 30-day purge does
 * it (services/bottleTrash.purgeTrashRows). Rows that refer to a bottle by id
 * elsewhere (tasting notes, personal data) stay, as after a delete in the app.
 *
 * Community price curves recompute on the weekly job (Sunday 02:00 UTC);
 * run `node src/runCommunityPrices.js` afterwards to refresh them now. The
 * running server's in-memory caches do not see a script's writes; they
 * expire on their own, within 30 minutes at most.
 *
 * SAFE BY DEFAULT: without --confirm it only reports what would be deleted.
 *
 * Usage (inside the backend container):
 *   node src/scripts/purge-user-bottles.js --user jagduvi79@gmail.com           # dry run
 *   node src/scripts/purge-user-bottles.js --user jagduvi79@gmail.com --confirm
 */

const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const DeletedBottle = require('../models/DeletedBottle');
const Rack = require('../models/Rack');
const { removeBottleCascade } = require('../services/bottleOps');
const { purgeTrashRows } = require('../services/bottleTrash');
const { OWN_PHOTO, REGISTRY_PHOTO } = require('../services/photoRetention');
const { logAudit } = require('../services/audit');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';
const VIA = 'purge-user-bottles';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

/**
 * Report what a purge of `user` covers and, with confirm, run it.
 * Returns the counts it reported, plus removed/failed/trashPurged on a run.
 */
async function purgeUserBottles(user, { confirm = false } = {}) {
  // Documents, not lean: the cascade deletes each with bottle.deleteOne().
  const bottles = await Bottle.find({ user: user._id });
  const ids = bottles.map((b) => b._id);

  const byStatus = {};
  for (const b of bottles) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  const report = {
    bottles: bottles.length,
    byStatus,
    cellars: new Set(bottles.map((b) => String(b.cellar))).size,
    ownPhotos: await BottleImage.countDocuments({ bottle: { $in: ids }, ...OWN_PHOTO }),
    registryPhotos: await BottleImage.countDocuments({ bottle: { $in: ids }, ...REGISTRY_PHOTO }),
    racks: await Rack.countDocuments({ 'slots.bottle': { $in: ids } }),
    trash: await DeletedBottle.countDocuments({ user: user._id }),
  };

  console.log(`[purge-user-bottles] User: ${user.username} <${user.email}> (${user._id})`);
  console.log(`[purge-user-bottles] Bottles: ${report.bottles} across ${report.cellars} cellar(s) — by status:`, byStatus);
  console.log(`[purge-user-bottles] Photos: ${report.ownPhotos} own (deleted with their files), ${report.registryPhotos} registry (kept, bottle ref cleared)`);
  console.log(`[purge-user-bottles] Racks with placements to clear: ${report.racks}`);
  console.log(`[purge-user-bottles] Recently deleted: ${report.trash} bottle(s) (deleted for good with their own photos)`);

  if (!confirm) {
    console.log('[purge-user-bottles] DRY RUN — nothing deleted. Re-run with --confirm to apply.');
    return report;
  }

  let removed = 0;
  let failed = 0;
  for (const bottle of bottles) {
    const result = await removeBottleCascade(bottle, null, 'bottle.delete', {
      anyStatus: true,
      auditDetail: { via: VIA },
    });
    if (result.error) {
      failed++;
      console.warn(`[purge-user-bottles] Bottle ${bottle._id} not deleted: ${result.error.message}`);
    } else {
      removed++;
    }
  }
  console.log(`[purge-user-bottles] Deleted ${removed} bottle(s)${failed ? `, ${failed} refused` : ''}`);

  const trashPurged = await purgeTrashRows({ user: user._id });
  if (trashPurged > 0) {
    logAudit(null, 'bottle.trash_purge', { type: 'user', id: user._id }, { bottles: trashPurged, via: VIA });
  }
  console.log(`[purge-user-bottles] Emptied ${trashPurged} bottle(s) from Recently deleted`);
  console.log('[purge-user-bottles] Done. Tip: run `node src/runCommunityPrices.js` to refresh community price curves now (otherwise Sunday 02:00 UTC).');

  return { ...report, removed, failed, trashPurged };
}

async function main() {
  const userArg = getArg('user');
  const confirm = process.argv.includes('--confirm');
  if (!userArg) {
    console.error('Usage: node src/scripts/purge-user-bottles.js --user <email-or-username> [--confirm]');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);

  const User = require('../models/User');
  const user = await User.findOne({
    $or: [{ email: userArg.toLowerCase() }, { username: userArg }],
  }).select('username email');
  if (!user) {
    console.error(`[purge-user-bottles] No user found for "${userArg}"`);
    process.exit(1);
  }

  await purgeUserBottles(user, { confirm });

  // logAudit persists fire-and-forget, which suits a long-lived server and not
  // a script that exits: disconnecting immediately would drop the last rows.
  if (confirm) await new Promise((resolve) => setTimeout(resolve, 1000));

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[purge-user-bottles] Failed:', err);
    process.exit(1);
  });
}

module.exports = { purgeUserBottles };
