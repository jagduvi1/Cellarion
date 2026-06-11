/**
 * Remove ALL bottles belonging to one user — for cleaning out test data
 * (e.g. the admin account's trial bottles), without touching the user's
 * account, cellars or racks themselves.
 *
 * Mirrors everything DELETE /api/bottles/:id cleans up, in bulk:
 *  - pulls the bottles out of any rack slots
 *  - removes them from the Meilisearch index
 *  - deletes their BottleImages + image files on disk — EXCEPT images that
 *    were promoted to a shared wine (assignedToWine), which other users see;
 *    those keep their file and doc, only the dangling bottle ref is cleared
 *  - deletes the bottle documents
 *
 * Community price curves recompute on the weekly job (Sunday 02:00 UTC);
 * run `node src/runCommunityPrices.js` afterwards to refresh them now.
 *
 * SAFE BY DEFAULT: without --confirm it only reports what would be deleted.
 *
 * Usage (inside the backend container):
 *   node src/scripts/purge-user-bottles.js --user jagduvi79@gmail.com           # dry run
 *   node src/scripts/purge-user-bottles.js --user jagduvi79@gmail.com --confirm
 */

const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : null;
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
  const Bottle = require('../models/Bottle');
  const BottleImage = require('../models/BottleImage');
  const Rack = require('../models/Rack');
  const searchService = require('../services/search');
  const { safeUploadPath } = require('../services/imageProcessor');

  const user = await User.findOne({
    $or: [{ email: userArg.toLowerCase() }, { username: userArg }],
  }).select('username email');
  if (!user) {
    console.error(`[purge-user-bottles] No user found for "${userArg}"`);
    process.exit(1);
  }

  const bottles = await Bottle.find({ user: user._id }).select('_id status cellar').lean();
  const ids = bottles.map((b) => b._id);

  const byStatus = {};
  for (const b of bottles) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
  const cellarCount = new Set(bottles.map((b) => String(b.cellar))).size;

  const images = await BottleImage.find({ bottle: { $in: ids } })
    .select('originalUrl processedUrl assignedToWine')
    .lean();
  const sharedImages = images.filter((i) => i.assignedToWine);
  const privateImages = images.filter((i) => !i.assignedToWine);

  const slotRacks = await Rack.countDocuments({ 'slots.bottle': { $in: ids } });

  console.log(`[purge-user-bottles] User: ${user.username} <${user.email}> (${user._id})`);
  console.log(`[purge-user-bottles] Bottles: ${ids.length} across ${cellarCount} cellar(s) — by status:`, byStatus);
  console.log(`[purge-user-bottles] Images: ${privateImages.length} private (deleted with files), ${sharedImages.length} promoted to shared wines (kept, bottle ref cleared)`);
  console.log(`[purge-user-bottles] Racks with placements to clear: ${slotRacks}`);

  if (!confirm) {
    console.log('[purge-user-bottles] DRY RUN — nothing deleted. Re-run with --confirm to apply.');
    await mongoose.disconnect();
    return;
  }

  // 1. Rack slots
  const rackRes = await Rack.updateMany(
    { 'slots.bottle': { $in: ids } },
    { $pull: { slots: { bottle: { $in: ids } } } }
  );
  console.log(`[purge-user-bottles] Cleared slots in ${rackRes.modifiedCount} rack(s)`);

  // 2. Private images: files off disk, then docs
  let filesRemoved = 0;
  for (const img of privateImages) {
    for (const url of [img.originalUrl, img.processedUrl]) {
      if (!url) continue;
      try {
        fs.unlinkSync(safeUploadPath(String(url).replace('/api/uploads/', '')));
        filesRemoved++;
      } catch { /* already gone or traversal-blocked */ }
    }
  }
  const imgRes = await BottleImage.deleteMany({ _id: { $in: privateImages.map((i) => i._id) } });
  // Shared wine images survive — just drop the now-dangling bottle ref
  const sharedRes = await BottleImage.updateMany(
    { _id: { $in: sharedImages.map((i) => i._id) } },
    { $unset: { bottle: '' } }
  );
  console.log(`[purge-user-bottles] Images: ${imgRes.deletedCount} doc(s) + ${filesRemoved} file(s) deleted, ${sharedRes.modifiedCount} shared image(s) detached`);

  // 3. Meilisearch (fire-and-forget per bottle, same as the API route)
  for (const id of ids) {
    try { searchService.removeBottle(id); } catch { /* index sync will heal */ }
  }

  // 4. The bottles themselves
  const delRes = await Bottle.deleteMany({ _id: { $in: ids } });
  console.log(`[purge-user-bottles] Deleted ${delRes.deletedCount} bottle(s)`);
  console.log('[purge-user-bottles] Done. Tip: run `node src/runCommunityPrices.js` to refresh community price curves now (otherwise Sunday 02:00 UTC).');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[purge-user-bottles] Failed:', err);
  process.exit(1);
});
