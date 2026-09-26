/**
 * One-time conversion of the kept photos to WebP (scaling audit 2026-09-25).
 *
 * New photos are stored as WebP of at most 2048 px (services/photoFormat).
 * Every photo processed before that is a full-resolution lossless PNG — or,
 * for an imported one, whatever the export carried. This converts those kept
 * files next to themselves:
 *
 *   processed/<name>.png|jpg  →  processed/<name>.webp
 *   originals/<name>.png|jpg  →  originals/<name>.webp   (only where the original
 *                                                        IS the kept photo — a
 *                                                        keepBackground row)
 *
 * Per file: encode, check the result decodes, write it (temp file + rename),
 * point every stored reference at it — BottleImage.processedUrl (contentHash
 * recomputed on the new bytes, the basis the export/re-import dedup uses) and
 * originalUrl, WineDefinition.image, WineRequest.image, JournalEntry.photos —
 * and only then delete the old file and its thumbnail. The new file's card
 * thumbnail is rendered on the way, so cellars don't queue renders afterwards.
 * No updatedAt moves: the photo is the same, so nothing re-syncs (the Bridge
 * pulls registry wines by updatedAt).
 *
 * The old address keeps working, for good (middleware/uploadsStatic
 * convertedPhotoFallback, and the thumbnail handler): copies Cellarion can't
 * rewrite — other servers' Bridge copies, Home Assistant, offline phones,
 * shared links — still load the photo.
 *
 * Not touched: label scans (curation evidence, kept as received), the source
 * of a failed rembg run (the retry needs it), imported never-cropped
 * originals, anything already WebP.
 *
 * Re-runnable: a converted file is no longer a candidate, a .webp left by an
 * interrupted run is reused, a reference still pointing at an old name is
 * moved, and an old file a run could not delete is removed by the next one.
 *
 * Usage (inside the backend container):
 *   node src/scripts/convert-photos-webp.js                      # dry-run (default): counts + size estimate
 *   node src/scripts/convert-photos-webp.js --apply              # convert everything
 *   node src/scripts/convert-photos-webp.js --apply --limit 100  # the first 100 files only
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const sharp = require('sharp');
const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const WineRequest = require('../models/WineRequest');
const JournalEntry = require('../models/JournalEntry');
// Re-indexing a wine populates its country, region and grapes: those models
// must be registered in this process too.
require('../models/Country');
require('../models/Region');
require('../models/Grape');
const { hashImageBytes } = require('../services/imageProcessor');
const { encodeKeptPhoto, KEPT_EXTENSION } = require('../services/photoFormat');
const { createThumbnailService } = require('../services/thumbnails');

const UPLOADS_ROOT = '/app/uploads';
const ESTIMATE_SAMPLE = 25;

// A kept photo's URL with a pre-WebP extension. processed/ holds every
// background-removed photo; originals/ only counts where a row's processedUrl
// points there (the original is the kept file).
const OLD_KEPT = /^\/api\/uploads\/(processed|originals)\/([A-Za-z0-9_-]+)\.(?:png|jpe?g)$/i;
const OLD_PROCESSED = /^\/api\/uploads\/processed\/[A-Za-z0-9_-]+\.(?:png|jpe?g)$/i;
// Any file this script reads or writes. The fixed folder and the character
// class leave no room for a path outside the uploads root.
const KEPT_FILE = /^\/api\/uploads\/(processed|originals)\/([A-Za-z0-9_-]+\.(?:png|jpe?g|webp))$/i;

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function webpUrlFor(url) {
  const m = OLD_KEPT.exec(url);
  return m ? `/api/uploads/${m[1]}/${m[2]}.${KEPT_EXTENSION}` : null;
}

function makeContext({ uploadsRoot = UPLOADS_ROOT } = {}) {
  return { uploadsRoot, thumbs: createThumbnailService({ uploadsRoot }) };
}

function diskPath(url, ctx) {
  const m = KEPT_FILE.exec(url);
  if (!m) throw new Error(`not a kept photo: ${url}`);
  return path.join(ctx.uploadsRoot, m[1], m[2]);
}

async function readIfPresent(file) {
  try {
    return await fs.promises.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeAtomic(file, bytes) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Every stored reference to a kept photo under a pre-WebP name, deduplicated. */
async function candidateUrls() {
  const [kept, wines, requests, journal] = await Promise.all([
    BottleImage.distinct('processedUrl', { kind: { $ne: 'label-scan' }, processedUrl: OLD_KEPT }),
    WineDefinition.distinct('image', { image: OLD_PROCESSED }),
    WineRequest.distinct('image', { image: OLD_PROCESSED }),
    JournalEntry.distinct('photos', { photos: OLD_PROCESSED }),
  ]);
  const all = new Set(kept.filter((url) => OLD_KEPT.test(url)));
  for (const url of [...wines, ...requests, ...journal]) {
    if (OLD_PROCESSED.test(url)) all.add(url);
  }
  return [...all].sort();
}

/** Point every stored reference to `from` at `to`. */
async function repoint(from, to, contentHash) {
  const wineIds = (await WineDefinition.find({ image: from }).select('_id').lean()).map((w) => String(w._id));
  const [processed, originals, wines, requests, journal] = await Promise.all([
    BottleImage.updateMany({ processedUrl: from }, { $set: { processedUrl: to, contentHash } }),
    BottleImage.updateMany({ originalUrl: from }, { $set: { originalUrl: to } }),
    WineDefinition.updateMany({ image: from }, { $set: { image: to } }),
    WineRequest.updateMany({ image: from }, { $set: { image: to } }),
    JournalEntry.updateMany({ photos: from }, { $set: { 'photos.$[p]': to } }, { arrayFilters: [{ p: from }] }),
  ]);
  return {
    images: processed.modifiedCount + originals.modifiedCount,
    wines: wines.modifiedCount,
    requests: requests.modifiedCount,
    journal: journal.modifiedCount,
    wineIds,
  };
}

/**
 * Convert one kept photo and move its references. Returns
 * `{ status, bytesBefore, bytesAfter, oldKept, moved }` — status 'converted',
 * or 'missing' when neither the old file nor a finished WebP exists (nothing
 * is changed then). Throws when the photo can't be converted; the old file
 * and every reference are then left as they were.
 */
async function convertPhoto(url, ctx) {
  const newUrl = webpUrlFor(url);
  if (!newUrl) throw new Error(`not a pre-WebP kept photo: ${url}`);
  const oldPath = diskPath(url, ctx);
  const newPath = diskPath(newUrl, ctx);

  const oldBytes = await readIfPresent(oldPath);
  let bytes = await readIfPresent(newPath); // a finished file from an interrupted run
  if (!oldBytes && !bytes) return { status: 'missing', bytesBefore: 0, bytesAfter: 0, oldKept: false, moved: null };
  if (!bytes) {
    bytes = await encodeKeptPhoto(oldBytes);
    const meta = await sharp(bytes).metadata();
    if (meta.format !== 'webp' || !meta.width || !meta.height) {
      throw new Error(`the converted file does not decode as WebP (${meta.format || 'unknown'})`);
    }
    await writeAtomic(newPath, bytes);
  }

  const moved = await repoint(url, newUrl, hashImageBytes(bytes));
  await ctx.thumbs.warmThumbFor(newUrl);

  let oldKept = false;
  if (oldBytes) {
    try {
      await fs.promises.unlink(oldPath);
    } catch (err) {
      // Converted and moved all the same; the next run's leftover sweep
      // retries the delete.
      if (err.code !== 'ENOENT') {
        oldKept = true;
        console.warn(`  kept old ${url}: ${err.message}`);
      }
    }
  }
  await ctx.thumbs.unlinkThumbFor(url);
  return {
    status: 'converted',
    bytesBefore: oldBytes && !oldKept ? oldBytes.length : 0,
    bytesAfter: bytes.length,
    oldKept,
    moved,
  };
}

async function isReferenced(url) {
  const counts = await Promise.all([
    BottleImage.countDocuments({ $or: [{ processedUrl: url }, { originalUrl: url }] }),
    WineDefinition.countDocuments({ image: url }),
    WineRequest.countDocuments({ image: url }),
    JournalEntry.countDocuments({ photos: url }),
  ]);
  return counts.some((n) => n > 0);
}

/**
 * Old processed files that a run converted and moved every reference away
 * from, but could not delete: nothing refers to them any more, so no later
 * run would find them as candidates — and processed/ has no orphan sweep.
 * Only a file whose WebP sibling exists qualifies.
 */
async function leftovers(ctx) {
  let names;
  try {
    names = await fs.promises.readdir(path.join(ctx.uploadsRoot, 'processed'));
  } catch {
    return [];
  }
  const present = new Set(names);
  const out = [];
  for (const name of names) {
    const m = /^([A-Za-z0-9_-]+)\.(?:png|jpe?g)$/i.exec(name);
    if (!m || !present.has(`${m[1]}.${KEPT_EXTENSION}`)) continue;
    const url = `/api/uploads/processed/${name}`;
    if (!(await isReferenced(url))) out.push(url);
  }
  return out;
}

async function estimate(urls, ctx) {
  const step = Math.max(1, Math.floor(urls.length / ESTIMATE_SAMPLE));
  let before = 0;
  let after = 0;
  let n = 0;
  for (let i = 0; i < urls.length && n < ESTIMATE_SAMPLE; i += step) {
    const bytes = await readIfPresent(diskPath(urls[i], ctx));
    if (!bytes) continue;
    try {
      after += (await encodeKeptPhoto(bytes)).length;
      before += bytes.length;
      n++;
    } catch { /* counted as a failure by --apply */ }
  }
  return n ? after / before : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Math.max(0, parseInt(process.argv[limitArg + 1], 10) || 0) : 0;
  const ctx = makeContext();

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Mode: ${apply ? 'APPLY (converting)' : 'DRY-RUN (no changes; pass --apply to execute)'}\n`);

  let urls = await candidateUrls();
  const found = urls.length;
  if (limit) urls = urls.slice(0, limit);

  let onDisk = 0;
  let bytesOnDisk = 0;
  for (const url of urls) {
    try {
      const st = await fs.promises.stat(diskPath(url, ctx));
      onDisk++;
      bytesOnDisk += st.size;
    } catch { /* missing — reported by --apply */ }
  }
  console.log(`Photos under a pre-WebP name: ${found}${limit ? ` (this run: ${urls.length})` : ''}`);
  console.log(`  on disk: ${onDisk}, ${mb(bytesOnDisk)}`);
  const stale = await leftovers(ctx);
  if (stale.length) console.log(`Old files already converted, left by an earlier run: ${stale.length}`);

  if (!apply) {
    const ratio = await estimate(urls, ctx);
    if (ratio !== null) {
      console.log(`  estimated after conversion: ${mb(bytesOnDisk * ratio)} (${(ratio * 100).toFixed(1)}% of today, from up to ${ESTIMATE_SAMPLE} sampled files)`);
    }
    console.log('\n(dry-run — nothing changed)');
    await mongoose.disconnect();
    return;
  }

  let staleRemoved = 0;
  for (const url of stale) {
    try {
      await fs.promises.unlink(diskPath(url, ctx));
      await ctx.thumbs.unlinkThumbFor(url);
      staleRemoved++;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`  kept old ${url}: ${err.message}`);
    }
  }

  // Without initialize() every indexWine below is a silent no-op, and wine
  // search keeps serving the old image names (they still load, via the
  // fallback, but the index should say what the registry says).
  const searchService = require('../services/search');
  await searchService.initialize();
  if (searchService.getIsAvailable?.() === false) {
    console.warn('Meilisearch unavailable — wine search keeps the old image names until the next reindex.');
  }

  const totals = { converted: 0, missing: 0, failed: 0, oldKept: 0, images: 0, wines: 0, requests: 0, journal: 0, bytesBefore: 0, bytesAfter: 0 };
  const wineIds = new Set();
  const started = Date.now();

  for (const [i, url] of urls.entries()) {
    try {
      const r = await convertPhoto(url, ctx);
      if (r.status === 'missing') {
        totals.missing++;
        console.log(`  missing  ${url}`);
      } else {
        totals.converted++;
        totals.bytesBefore += r.bytesBefore;
        totals.bytesAfter += r.bytesAfter;
        if (r.oldKept) totals.oldKept++;
        totals.images += r.moved.images;
        totals.wines += r.moved.wines;
        totals.requests += r.moved.requests;
        totals.journal += r.moved.journal;
        for (const id of r.moved.wineIds) wineIds.add(id);
      }
    } catch (err) {
      totals.failed++;
      console.warn(`  failed   ${url}: ${err.message}`);
    }
    if ((i + 1) % 200 === 0) {
      console.log(`  … ${i + 1}/${urls.length} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
  }

  for (const id of wineIds) await searchService.indexWine(id);

  console.log(`\nConverted: ${totals.converted}`);
  console.log(`  missing on disk (skipped):   ${totals.missing}`);
  console.log(`  failed (a re-run retries):   ${totals.failed}`);
  console.log(`  old file kept (re-run):      ${totals.oldKept}`);
  console.log(`  references moved: ${totals.images} images, ${totals.wines} wines, ${totals.requests} wine requests, ${totals.journal} journal entries`);
  console.log(`  wines re-indexed for search: ${wineIds.size}`);
  console.log(`  disk: ${mb(totals.bytesBefore)} removed, ${mb(totals.bytesAfter)} written`);
  if (stale.length) console.log(`  leftovers of an earlier run removed: ${staleRemoved}/${stale.length}`);
  console.log(`  time: ${Math.round((Date.now() - started) / 1000)} s`);

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { convertPhoto, candidateUrls, leftovers, webpUrlFor, makeContext };
