/**
 * backfill-image-content-hashes.js
 *
 * One-off backfill: stamp BottleImage.contentHash on every image that doesn't
 * have one yet (i.e. images uploaded/approved before content-hashing existed).
 *
 * Why: the cellar importer (services/cellarImport.js) skips re-writing an image
 * the user already has by matching { uploadedBy, contentHash }. That hash was
 * only ever set on import, so live-uploaded and admin-approved images had none —
 * meaning re-importing a cellar export would DUPLICATE those images on disk.
 * After this backfill (and the upload/processor changes that now stamp the hash
 * going forward), re-import dedups against everything the user already has.
 *
 * The hash is taken from the bytes we keep and export: the cropped (processed)
 * image when present, else the original — the same basis the importer uses.
 *
 * Behaviour:
 *   - DRY-RUN by default: reports what would be hashed, changes nothing.
 *   - Pass --apply to actually write contentHash.
 *   - Only touches images with no contentHash; existing hashes are left as-is.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/backfill-image-content-hashes.js          # dry run
 *   docker exec cellarion-backend node src/scripts/backfill-image-content-hashes.js --apply
 *
 * Or locally (requires .env):
 *   cd backend && node src/scripts/backfill-image-content-hashes.js
 */

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const BottleImage = require('../models/BottleImage');
const { safeUploadPath, hashImageBytes } = require('../services/imageProcessor');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

/** Resolve the on-disk file whose bytes define this image's hash: the cropped
 *  (processed) version if it exists, else the original. Returns null if neither
 *  file is present on disk. */
function fileForImage(image) {
  for (const url of [image.processedUrl, image.originalUrl]) {
    if (!url || typeof url !== 'string' || !url.startsWith('/api/uploads/')) continue;
    try {
      const p = safeUploadPath(url.replace('/api/uploads/', ''));
      if (fs.existsSync(p)) return p;
    } catch { /* path traversal guard threw — skip */ }
  }
  return null;
}

async function run() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');
  console.log(APPLY ? 'Mode: APPLY (contentHash will be written)' : 'Mode: DRY RUN (no changes)');
  console.log('');

  const filter = { $or: [{ contentHash: null }, { contentHash: { $exists: false } }] };
  const total = await BottleImage.countDocuments(filter);
  console.log(`BottleImages without a contentHash: ${total}`);
  if (total === 0) {
    console.log('\nNothing to do.');
    await mongoose.disconnect();
    return;
  }

  let scanned = 0, hashed = 0, noFile = 0;
  const cursor = BottleImage.find(filter).select('_id originalUrl processedUrl').cursor();
  for (let image = await cursor.next(); image != null; image = await cursor.next()) {
    scanned++;
    const filePath = fileForImage(image);
    if (!filePath) { noFile++; continue; }
    let hash;
    try {
      hash = hashImageBytes(fs.readFileSync(filePath));
    } catch (err) {
      noFile++;
      continue;
    }
    if (APPLY) {
      await BottleImage.updateOne({ _id: image._id }, { $set: { contentHash: hash } });
    }
    hashed++;
    if (scanned % 500 === 0) console.log(`  …scanned ${scanned}/${total}`);
  }

  console.log(`\nScanned:                 ${scanned}`);
  console.log(`${APPLY ? 'Hashed' : 'Would hash'}:              ${hashed}`);
  console.log(`Skipped (file missing):  ${noFile}`);
  if (!APPLY) console.log('\n(dry run — pass --apply to write)');
  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
