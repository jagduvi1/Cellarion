/**
 * Cellar-export importer (Cellarion format).
 *
 * The additive counterpart to services/cellarExport.js: takes a Cellarion
 * export (the `cellarion-export@1` JSON, optionally with the image files from
 * the ZIP) and rebuilds the cellar(s) for the importing user — into a fresh
 * self-hosted instance or back into the same one. This is the import half of
 * the anti-lock-in promise.
 *
 * It does NOT touch the existing multi-format importer (routes/import.js +
 * utils/importMappers.js, which handles Vivino/CellarTracker/Oeno/generic CSV).
 * Instead it reuses the same canonical building blocks:
 *   - findOrCreateWine()            — resolve/auto-create the WineDefinition
 *   - planRackCreations / placeBottlesInRack — rack creation + slot placement
 *   - getMaxPosition                — rack capacity
 *   - unlinkImageFiles / safeUploadPath — disk file handling
 * so behaviour stays consistent with the rest of the app.
 *
 * Per-cellar name policy (caller-driven): if the target name matches an
 * existing owned cellar it is OVERWRITTEN (full replace of contents, keeping
 * the cellar doc + members/sharing); otherwise a NEW cellar is created.
 *
 * Image rule: only the user's own images are in the export; on import an
 * identical image the user already has (same SHA-256) is reused on disk instead
 * of being written again (dedup), guarded by reference-safe unlinkImageFiles.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const { RACK_TYPES } = require('../models/Rack');
const CellarLayout = require('../models/CellarLayout');
const BottleImage = require('../models/BottleImage');
const WineRequest = require('../models/WineRequest');
const Review = require('../models/Review');
const WineVintageProfile = require('../models/WineVintageProfile');

const searchService = require('./search');
const { findOrCreateWine } = require('./findOrCreateWine');
const { unlinkImageFiles, safeUploadPath } = require('./imageProcessor');
const { ORIGINALS_DIR, PROCESSED_DIR } = require('../config/upload');
const { planRackCreations, placeBottlesInRack, DEFAULT_ANCHOR } = require('../utils/rackImport');
const { getMaxPosition } = require('../utils/rackGeometry');
const { resolveRating } = require('../utils/ratingUtils');
const { normalizeBottleSize, DEFAULT_SIZE } = require('../config/bottleSizes');
const { stripHtml } = require('../utils/sanitize');
const { parseAndValidateVintage } = require('../utils/validation');
const { CONSUMED_STATUSES } = require('../config/constants');

const EXPORT_SCHEMA = 'cellarion-export@1';
const MAX_IMAGES_PER_BOTTLE = 20;
// Import-side DoS bounds: a crafted data.json must not be able to drive unbounded
// sequential DB work (one cellar + per-bottle wine resolution / saves each).
// Generous vs any real migration; the export side caps at EXPORT_MAX = 50000.
const MAX_IMPORT_CELLARS = 100;
const MAX_IMPORT_BOTTLES = 50000;

// ── Pure helpers (unit-tested without a DB) ──────────────────────────────────

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/** Reject pathologically large imports up front, before any DB work. */
function enforceImportLimits(cellars) {
  if (cellars.length > MAX_IMPORT_CELLARS) {
    throw badRequest(`Import has too many cellars (${cellars.length}; max ${MAX_IMPORT_CELLARS})`);
  }
  const totalBottles = cellars.reduce((n, c) => n + (Array.isArray(c.bottles) ? c.bottles.length : 0), 0);
  if (totalBottles > MAX_IMPORT_BOTTLES) {
    throw badRequest(`Import has too many bottles (${totalBottles}; max ${MAX_IMPORT_BOTTLES})`);
  }
}

/**
 * Parse + validate a Cellarion export document into a normalized shape:
 *   { cellars: [{ cellarName, description, racks[], bottles[] }] }
 * Accepts the cellar-nested `cellarion-export@1` format, and (for resilience) a
 * legacy flat `{bottles:[]}` or bare bottle array as a single unnamed cellar.
 * Throws a 400-tagged error on anything unrecognised.
 */
function parseCellarExport(input) {
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch {
      throw badRequest('File is not valid JSON');
    }
  }
  if (!doc || typeof doc !== 'object') throw badRequest('Empty or invalid export');

  if (Array.isArray(doc.cellars)) {
    if (doc.schema && doc.schema !== EXPORT_SCHEMA) {
      throw badRequest(`Unsupported export schema: ${doc.schema}`);
    }
    const cellars = doc.cellars.map((c, i) => ({
      cellarName: String(c.cellarName || `Imported cellar ${i + 1}`).trim() || `Imported cellar ${i + 1}`,
      description: String(c.description || ''),
      racks: Array.isArray(c.racks) ? c.racks : [],
      layout: c.layout && typeof c.layout === 'object' ? c.layout : null,
      bottles: Array.isArray(c.bottles) ? c.bottles : [],
    }));
    if (cellars.length === 0) throw badRequest('Export contains no cellars');
    enforceImportLimits(cellars);
    return { cellars };
  }

  const bottles = Array.isArray(doc) ? doc : (Array.isArray(doc.bottles) ? doc.bottles : null);
  if (bottles) {
    const cellars = [{ cellarName: 'Imported cellar', description: '', racks: [], layout: null, bottles }];
    enforceImportLimits(cellars);
    return { cellars };
  }

  throw badRequest('Unrecognised export format');
}

/**
 * Reverse of cellarExport.urlToArchivePath:
 *   'images/originals/x.jpg' → '/api/uploads/originals/x.jpg'
 * Returns null for anything not under the archive's images/ folder.
 */
function archivePathToUrl(archivePath) {
  if (!archivePath || typeof archivePath !== 'string') return null;
  if (!archivePath.startsWith('images/')) return null;
  return `/api/uploads/${archivePath.slice('images/'.length)}`;
}

/**
 * Decide create-vs-overwrite for each export cellar.
 * @param cellars        from parseCellarExport
 * @param existingNamesLc Set of LOWERCASED active cellar names owned by the user
 * @param overrides      { [sourceName]: targetName } user renames
 * Returns [{ sourceName, targetName, mode: 'create'|'overwrite', collides }]
 */
function resolveTargets(cellars, existingNamesLc, overrides = {}) {
  return cellars.map((c) => {
    const sourceName = c.cellarName;
    const targetName = String(overrides[sourceName] != null ? overrides[sourceName] : sourceName).trim();
    const collides = !!targetName && existingNamesLc.has(targetName.toLowerCase());
    return { sourceName, targetName, mode: collides ? 'overwrite' : 'create', collides };
  });
}

/**
 * Map an export bottle into the "item" shape the rack helpers + bottle build
 * understand (mirrors the fields routes/import.js /confirm consumes). The
 * bottle's image references are carried separately (see importCellar).
 */
function exportBottleToItem(b) {
  return {
    wineName: b.wineName || '',
    producer: b.producer || '',
    country: b.country || '',
    region: b.region || '',
    appellation: b.appellation || '',
    type: b.type || '',
    vintage: b.vintage || 'NV',
    price: b.price,
    currency: b.currency,
    bottleSize: b.bottleSize,
    purchaseDate: b.purchaseDate,
    purchaseLocation: b.purchaseLocation,
    purchaseUrl: b.purchaseUrl,
    location: b.location,
    notes: b.notes,
    rating: b.rating,
    ratingScale: b.ratingScale,
    dateAdded: b.dateAdded,
    addToHistory: !!b.addToHistory,
    consumedReason: b.consumedReason,
    consumedAt: b.consumedAt,
    consumedNote: b.consumedNote,
    consumedRating: b.consumedRating,
    consumedRatingScale: b.consumedRatingScale,
    // Placement: rackPosition is Cellarion's internal 1-indexed slot (from the
    // export); row/col are the human row/col the export also records (grid only).
    // `internalSlot` tells computeRackPosition this position is already a
    // resolved internal slot — so shelf/x-rack/hex/… racks round-trip instead of
    // having the slot index mis-read as a shelf number.
    rackName: b.rackName,
    rackPosition: b.rackPosition,
    internalSlot: b.rackPosition != null && b.rackPosition !== '',
    row: b.rackRow,
    col: b.rackCol,
    // Carried through (handled separately from the bottle build).
    reviews: Array.isArray(b.reviews) ? b.reviews : [],
    // Sommelier maturity window for this wine+vintage (handled separately).
    maturity: (b.maturity && typeof b.maturity === 'object') ? b.maturity : null,
  };
}

const clampDim = (n, fallback) => Math.max(1, Math.min(20, parseInt(n, 10) || fallback));

// ── DB-touching import (one cellar) ──────────────────────────────────────────

function fileOnDisk(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/api/uploads/')) return false;
  try {
    return fs.existsSync(safeUploadPath(url.replace('/api/uploads/', '')));
  } catch {
    return false;
  }
}

/** Full-replace a cellar's contents while keeping the Cellar doc + members. */
async function clearCellarContents(cellarId) {
  const bottles = await Bottle.find({ cellar: cellarId }).select('_id').lean();
  const bottleIds = bottles.map((b) => b._id);
  if (bottleIds.length) {
    // Bottle deletion does NOT cascade images/reviews — clean those up ourselves
    // before deleting the bottles (else they dangle pointing at deleted bottles).
    const images = await BottleImage.find({ bottle: { $in: bottleIds } });
    for (const img of images) await unlinkImageFiles(img); // reference-safe (dedup-shared files survive)
    await BottleImage.deleteMany({ bottle: { $in: bottleIds } });
    await Review.deleteMany({ bottle: { $in: bottleIds } });
    for (const id of bottleIds) {
      try { await searchService.removeBottle(id); } catch { /* keep Meili clean, best-effort */ }
    }
    await Bottle.deleteMany({ cellar: cellarId });
  }
  await Rack.deleteMany({ cellar: cellarId });
  await CellarLayout.deleteMany({ cellar: cellarId });
}

/** A throwaway cellar name used while an overwrite import is built in isolation.
 *  Random per import so two concurrent imports by the same user never collide on
 *  the { user, name } partial-unique index. */
function stagingCellarName() {
  return `__cellarion_staging_${crypto.randomUUID()}`;
}

/**
 * Replace a LIVE cellar's contents with those just built in a throwaway STAGING
 * cellar, preserving the live cellar's _id, name, members, sharing and per-user
 * colors.
 *
 * This is the safe half of an overwrite import. The destructive clear of the
 * live cellar happens HERE — only after the whole import has succeeded and the
 * replacement data is fully materialised in `staging`. A failure during the
 * build therefore never destroys the user's existing bottles, photos,
 * consumption history or 3D layout (the previous implementation cleared the live
 * cellar up-front and lost everything on a mid-import crash/OOM/throw).
 *
 * Not a single DB transaction (self-hosted Mongo is typically standalone, so
 * multi-doc transactions aren't available), but the only destructive step runs
 * after the new data is durable, and even if the re-point below is interrupted
 * the new content still exists in `staging` and is recoverable — nothing is
 * irreversibly lost.
 */
async function swapCellarContents(live, staging, description) {
  // 1. Drop the live cellar's OLD contents (bottles + their image files/reviews,
  //    racks, layout). Safe now: no new data is generated after this point.
  //    unlinkImageFiles is reference-safe, so any file the staging import deduped
  //    onto (still referenced by a staging BottleImage) is preserved.
  await clearCellarContents(live._id);
  // 2. Move the freshly built content onto the live cellar's _id. BottleImage and
  //    Review reference the bottle (unchanged) and travel with it automatically;
  //    only the cellar pointer on Bottle / Rack / CellarLayout is re-homed.
  await Bottle.updateMany({ cellar: staging._id }, { $set: { cellar: live._id } });
  await Rack.updateMany({ cellar: staging._id }, { $set: { cellar: live._id } });
  await CellarLayout.updateMany({ cellar: staging._id }, { $set: { cellar: live._id } });
  // 3. Carry over the imported description; keep the live name / members / _id.
  if (typeof description === 'string' && live.description !== description) {
    live.description = description;
    await live.save();
  }
  // 4. Remove the now-empty staging cellar doc.
  await Cellar.deleteOne({ _id: staging._id });
}

/** Create the racks for a cellar: exact geometry from the export, falling back
 *  to inferred dimensions for any rackName a bottle references but the export
 *  didn't define. */
async function createRacks(cellarId, userId, cellar, items, result) {
  const specByName = new Map();
  for (const r of cellar.racks || []) {
    if (r && r.name) specByName.set(String(r.name).trim(), r);
  }
  const inferred = planRackCreations(items); // Map name -> { type, rows, cols }
  const allNames = new Set([...specByName.keys(), ...inferred.keys()].filter(Boolean));
  if (allNames.size === 0) return;

  const existing = await Rack.find({ cellar: cellarId, name: { $in: [...allNames] }, deletedAt: null })
    .select('name').lean();
  const existingNames = new Set(existing.map((r) => r.name));

  for (const name of allNames) {
    if (existingNames.has(name)) continue;
    const spec = specByName.get(name);
    const inf = inferred.get(name) || {};
    const chosenType = spec?.type || inf.type || 'grid';
    const safeType = RACK_TYPES.includes(chosenType) ? chosenType : 'grid';
    const rackData = {
      cellar: cellarId,
      user: userId,
      name,
      type: safeType,
      rows: clampDim(spec?.rows || inf.rows, 1),
      cols: clampDim(spec?.cols || inf.cols, 1),
    };
    if (spec?.typeConfig) rackData.typeConfig = spec.typeConfig;
    try {
      await new Rack(rackData).save();
      result.racksCreated++;
    } catch (err) {
      console.warn(`[cellarImport] rack "${name}" create failed (non-fatal):`, err.message);
    }
  }
}

/** Resolve a wine: auto-create via findOrCreateWine, else fall back to a
 *  pending WineRequest (mirrors the existing importer's no-match path). */
async function resolveWine(item, userId, cache, result) {
  const name = (item.wineName || item.producer || '').trim();
  const producer = (item.producer || '').trim();
  if (!name) return { error: 'Wine name or producer is required' };

  try {
    const { wine, created } = await findOrCreateWine(
      { name, producer: producer || name, country: item.country, region: item.region,
        appellation: item.appellation, type: item.type, grapes: [] },
      userId,
      { confirmCreate: true } // non-interactive: match >= 0.95 or create
    );
    if (wine) {
      if (created) result.winesCreated++;
      return { wineDefinitionId: wine._id };
    }
  } catch (err) {
    // Most commonly: country missing (findOrCreateWine throws 400). Fall through
    // to a WineRequest so the bottle is still imported (pending admin review).
    if (err.status !== 400) console.warn('[cellarImport] findOrCreateWine error:', err.message);
  }

  const key = `${name.toLowerCase()}|${producer.toLowerCase()}`;
  let wineRequest = cache.get(key);
  if (!wineRequest) {
    wineRequest = await WineRequest.create({
      requestType: 'new_wine',
      wineName: name,
      producer: producer || undefined,
      user: userId,
      status: 'pending',
    });
    cache.set(key, wineRequest);
    result.wineRequests++;
  }
  return { wineRequestId: wineRequest._id };
}

/** Build (but don't save) a Bottle from an export item — mirrors routes/import.js. */
function buildBottle({ cellarId, ownerId, item, canonicalVintage, wineDefinitionId, pendingWineRequestId, defaultCurrency }) {
  const priceSetAt = (item.price != null && item.price !== '') ? new Date() : undefined;
  const bottle = new Bottle({
    cellar: cellarId,
    user: ownerId,
    ...(wineDefinitionId ? { wineDefinition: wineDefinitionId } : { pendingWineRequest: pendingWineRequestId }),
    vintage: canonicalVintage,
    price: item.price || undefined,
    currency: item.currency || defaultCurrency || 'USD',
    priceSetAt,
    bottleSize: normalizeBottleSize(item.bottleSize) || DEFAULT_SIZE,
    purchaseDate: item.purchaseDate || undefined,
    purchaseLocation: stripHtml(item.purchaseLocation),
    purchaseUrl: item.purchaseUrl || undefined,
    location: stripHtml(item.location),
    notes: stripHtml(item.notes),
  });
  if (item.dateAdded) bottle.createdAt = new Date(item.dateAdded);
  // "In this cellar since" = the added date. cellarHistory is seeded by the
  // backfill migration / on first move (avoids re-keying it through the
  // overwrite staging-swap).
  bottle.addedToCellarAt = bottle.createdAt;
  return bottle;
}

/** Attach a bottle's images from the export, deduping identical bytes.
 *
 *  Exports carry the CROPPED (processed) image; the pre-crop original is only
 *  present as a fallback for images that were never background-removed. We store
 *  the processed file when it exists and keep an original ONLY when there is no
 *  processed version — we never re-introduce a pre-crop original alongside a
 *  cropped one. Older exports that still carry both are normalised the same way. */
async function attachImages(bottle, images, userId, getFileBuffer, result) {
  if (!Array.isArray(images) || images.length === 0) return;
  let firstImageId = null;
  let count = 0;

  for (const img of images) {
    if (count >= MAX_IMAGES_PER_BOTTLE) break;
    const origArchive = img && img.original;
    const procArchive = img && img.processed;
    const procBuf = procArchive ? getFileBuffer(procArchive) : null;
    const origBuf = origArchive ? getFileBuffer(origArchive) : null;
    // Prefer the cropped image; fall back to the original only when that's all
    // the export carries. Skip if neither file is present (JSON-only import).
    const primaryBuf = procBuf || origBuf;
    if (!primaryBuf) continue;

    const hash = crypto.createHash('sha256').update(primaryBuf).digest('hex');

    let originalUrl = null;
    let processedUrl = null;
    let deduped = false;

    // Dedup: does this user already have a byte-identical image still on disk?
    const existing = await BottleImage.findOne({ uploadedBy: userId, contentHash: hash })
      .select('originalUrl processedUrl').lean();
    if (existing && (fileOnDisk(existing.processedUrl) || fileOnDisk(existing.originalUrl))) {
      processedUrl = fileOnDisk(existing.processedUrl) ? existing.processedUrl : null;
      originalUrl = fileOnDisk(existing.originalUrl) ? existing.originalUrl : null;
      deduped = true;
    } else {
      const uuid = crypto.randomUUID();
      if (procBuf) {
        const procName = `${uuid}.png`;
        fs.writeFileSync(path.join(PROCESSED_DIR, procName), procBuf);
        processedUrl = `/api/uploads/processed/${procName}`;
      } else {
        // Original-only image (never cropped) — keep it so the photo isn't lost.
        const ext = (path.extname(origArchive) || '.jpg').toLowerCase();
        const origName = `${uuid}${ext}`;
        fs.writeFileSync(path.join(ORIGINALS_DIR, origName), origBuf);
        originalUrl = `/api/uploads/originals/${origName}`;
      }
    }

    const doc = await BottleImage.create({
      bottle: bottle._id,
      uploadedBy: userId,
      originalUrl,
      processedUrl,
      status: 'approved',   // already-processed export image → skip rembg
      visibility: 'private',
      credit: (img && img.credit) || null,
      contentHash: hash,
    });
    if (deduped) result.imagesDeduped++; else result.imagesAttached++;
    if (!firstImageId) firstImageId = doc._id;
    count++;
  }

  if (firstImageId) {
    bottle.defaultImage = firstImageId;
    await bottle.save();
  }
}

const VALID_RATING_SCALES = ['5', '20', '100'];

/** Re-create the user's reviews of a bottle's wine. Needs the resolved
 *  wineDefinition (Review requires it); reviews on wine-request bottles are
 *  counted as skipped. */
async function attachReviews(bottle, reviews, userId, wineDefinitionId, result) {
  if (!Array.isArray(reviews) || reviews.length === 0) return;
  if (!wineDefinitionId) { result.reviewsSkipped += reviews.length; return; }
  for (const r of reviews) {
    const rating = Number(r.rating);
    if (!Number.isFinite(rating) || !VALID_RATING_SCALES.includes(String(r.ratingScale))) {
      result.reviewsSkipped++;
      continue;
    }
    try {
      await Review.create({
        author: userId,
        wineDefinition: wineDefinitionId,
        bottle: bottle._id,
        vintage: r.vintage || bottle.vintage || null,
        rating,
        ratingScale: String(r.ratingScale),
        tasting: (r.tasting && typeof r.tasting === 'object') ? {
          aroma: stripHtml(r.tasting.aroma),
          palate: stripHtml(r.tasting.palate),
          finish: stripHtml(r.tasting.finish),
          overall: stripHtml(r.tasting.overall),
        } : undefined,
        visibility: r.visibility === 'private' ? 'private' : 'public',
      });
      result.reviewsCreated++;
    } catch {
      result.reviewsSkipped++;
    }
  }
}

/** Re-create the sommelier maturity (drink-window) profile for a bottle's
 *  wine + vintage from the export.
 *
 *  Create-only by design: if the destination already has ANY profile for this
 *  wine+vintage (pending or reviewed) it is left untouched — an import never
 *  overwrites curated maturity data, so it can't poison a shared registry. On a
 *  fresh instance (the self-hosted migration case) where no profile exists yet,
 *  the imported window is restored in full. Deduped per wine+vintage via `seen`
 *  so bottles that share a wine only trigger this once. */
async function attachMaturity(maturity, wineDefinitionId, vintage, result, seen) {
  if (!maturity || typeof maturity !== 'object') return;
  if (!wineDefinitionId || !vintage || vintage === 'NV') return;

  const key = `${wineDefinitionId}:${vintage}`;
  if (seen.has(key)) return; // already handled for this wine+vintage
  seen.add(key);

  // Keep only valid window boundaries (integer years/offsets, 0..2200 per model).
  const fields = {};
  for (const k of ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil']) {
    const n = Number(maturity[k]);
    if (Number.isInteger(n) && n >= 0 && n <= 2200) fields[k] = n;
  }
  if (Object.keys(fields).length === 0) return; // no usable window → nothing to store

  try {
    const existing = await WineVintageProfile
      .findOne({ wineDefinition: wineDefinitionId, vintage }).select('_id').lean();
    if (existing) { result.maturitySkipped++; return; } // never clobber existing curated data

    await WineVintageProfile.create({
      wineDefinition: wineDefinitionId,
      vintage,
      status: 'reviewed',
      relative: !!maturity.relative,
      ...fields,
      sommNotes: maturity.sommNotes ? stripHtml(String(maturity.sommNotes)).slice(0, 2000) : undefined,
    });
    result.maturityCreated++;
  } catch {
    // Unique-index race (another bottle created it first) or a validation miss —
    // treat as skipped rather than failing the whole import.
    result.maturitySkipped++;
  }
}

/** Re-create the 3D room layout, re-linking rack placements by rack name to the
 *  racks just created in this cellar. */
async function createLayout(cellarId, layout, result) {
  if (!layout || !Array.isArray(layout.rackPlacements)) return;
  const racks = await Rack.find({ cellar: cellarId, deletedAt: null }).select('_id name').lean();
  const nameToId = new Map(racks.map((r) => [r.name, r._id]));
  const placements = [];
  for (const p of layout.rackPlacements) {
    const id = nameToId.get(p.rackName);
    if (!id) continue; // placement for a rack that wasn't created — skip
    placements.push({
      rack: id,
      position: p.position,
      rotation: p.rotation,
      wall: p.wall,
      group: p.group ?? null,
      widthOverride: p.widthOverride,
      depthOverride: p.depthOverride,
      scaleOverride: p.scaleOverride,
    });
  }
  if (placements.length === 0 && !layout.roomDimensions) return;
  try {
    // CellarLayout is unique per cellar; overwrite already cleared any old one.
    await CellarLayout.deleteOne({ cellar: cellarId });
    await CellarLayout.create({
      cellar: cellarId,
      ...(layout.roomDimensions ? { roomDimensions: layout.roomDimensions } : {}),
      rackPlacements: placements,
    });
    result.layoutImported = true;
  } catch (err) {
    console.warn('[cellarImport] layout create failed (non-fatal):', err.message);
  }
}

/**
 * Build all of a cellar's content — racks, 3D room layout, then bottles (+ their
 * wines, images, reviews and maturity windows) and finally rack placement — into
 * the cellar identified by `cellarId`. Per-bottle problems are collected into
 * `result`; only an unexpected failure rejects. Returns the ids of the active
 * bottles created, for search indexing.
 */
async function buildCellarContents({ cellarId, ownerId, userId, cellar, items, imagesByIndex, anchor, getFileBuffer, defaultCurrency, result }) {
  // Racks (exact geometry, fallback inference), then the 3D room layout.
  await createRacks(cellarId, ownerId, cellar, items, result);
  await createLayout(cellarId, cellar.layout, result);

  // Bottles + wines + images. Collect placement intents.
  const requestCache = new Map();
  const createdActiveIds = [];
  const pendingPlacements = [];
  const seenMaturity = new Set(); // wine+vintage pairs already reconstituted

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const vc = parseAndValidateVintage(item.vintage);
    if (!vc.ok) { result.errors.push({ index: i, reason: vc.error }); continue; }
    const canonicalVintage = vc.value;

    try {
      const { rating, ratingScale, error: ratingError } = resolveRating(item.rating, item.ratingScale);
      if (ratingError) { result.errors.push({ index: i, reason: ratingError }); continue; }

      const { rating: cRating, ratingScale: cScale, error: cRatingError } =
        item.addToHistory ? resolveRating(item.consumedRating, item.consumedRatingScale) : { rating: undefined, ratingScale: undefined, error: null };
      if (cRatingError) { result.errors.push({ index: i, reason: cRatingError }); continue; }

      if (item.addToHistory && item.consumedReason && !CONSUMED_STATUSES.includes(item.consumedReason)) {
        result.errors.push({ index: i, reason: 'Invalid consumed reason' });
        continue;
      }

      const wine = await resolveWine(item, userId, requestCache, result);
      if (wine.error) { result.errors.push({ index: i, reason: wine.error }); continue; }

      const bottle = buildBottle({
        cellarId, ownerId, item, canonicalVintage,
        wineDefinitionId: wine.wineDefinitionId,
        pendingWineRequestId: wine.wineRequestId,
        defaultCurrency,
      });
      if (!item.addToHistory && rating !== undefined) {
        bottle.rating = rating;
        bottle.ratingScale = ratingScale;
      }
      if (item.addToHistory) {
        const reason = item.consumedReason || 'drank';
        bottle.status = reason;
        bottle.consumedReason = reason;
        bottle.consumedAt = item.consumedAt ? new Date(item.consumedAt) : new Date();
        if (item.consumedNote) bottle.consumedNote = stripHtml(item.consumedNote);
        if (cRating !== undefined) { bottle.consumedRating = cRating; bottle.consumedRatingScale = cScale; }
      }

      await bottle.save();
      result.bottlesCreated++;
      if (bottle.status === 'active') createdActiveIds.push(bottle._id);

      await attachImages(bottle, imagesByIndex[i], userId, getFileBuffer, result);
      await attachReviews(bottle, item.reviews, userId, wine.wineDefinitionId, result);
      await attachMaturity(item.maturity, wine.wineDefinitionId, canonicalVintage, result, seenMaturity);

      const hasPlacement = item.rackName && (item.rackPosition || (item.row && item.col));
      if (hasPlacement && bottle.status === 'active') {
        pendingPlacements.push({ rackName: String(item.rackName), item, bottleId: bottle._id, sourceIndex: i });
      }
    } catch (err) {
      result.errors.push({ index: i, reason: err.message });
    }
  }

  // Per-rack two-pass placement (same helper the CSV importer uses).
  if (pendingPlacements.length > 0) {
    const byRack = new Map();
    for (const p of pendingPlacements) {
      if (!byRack.has(p.rackName)) byRack.set(p.rackName, []);
      byRack.get(p.rackName).push(p);
    }
    for (const [rackName, group] of byRack.entries()) {
      try {
        const rack = await Rack.findOne({ cellar: cellarId, name: rackName, deletedAt: null });
        if (!rack) {
          for (const p of group) result.unplaced.push({ sourceIndex: p.sourceIndex, rackName, requestedPosition: null, reason: 'Rack not found' });
          continue;
        }
        const { placements, unplaced } = placeBottlesInRack({
          type: rack.type,
          rows: rack.rows,
          cols: rack.cols,
          typeConfig: rack.typeConfig?.toObject ? rack.typeConfig.toObject() : rack.typeConfig,
          slots: rack.slots,
          maxPosition: getMaxPosition(rack),
        }, group, anchor);
        for (const pl of placements) rack.slots.push({ position: pl.position, bottle: pl.bottle });
        for (const u of unplaced) result.unplaced.push({ ...u, rackName });
        if (placements.length > 0) await rack.save();
      } catch (err) {
        for (const p of group) result.unplaced.push({ sourceIndex: p.sourceIndex, rackName, requestedPosition: null, reason: err.message });
      }
    }
  }

  return createdActiveIds;
}

/**
 * Import a single cellar from a parsed export.
 *
 * @param userId   importing user (becomes owner of created cellar/bottles/images)
 * @param cellar   one entry from parseCellarExport().cellars
 * @param opts     { targetName, mode: 'create'|'overwrite', getFileBuffer(archivePath)->Buffer|null, defaultCurrency }
 * @returns per-cellar result object
 */
async function importCellar(userId, cellar, opts) {
  const anchor = DEFAULT_ANCHOR; // export positions are top-left internal slots
  const getFileBuffer = opts.getFileBuffer || (() => null);
  const result = {
    sourceName: cellar.cellarName,
    targetName: opts.targetName,
    mode: opts.mode,
    bottlesCreated: 0,
    racksCreated: 0,
    imagesAttached: 0,
    imagesDeduped: 0,
    winesCreated: 0,
    wineRequests: 0,
    reviewsCreated: 0,
    reviewsSkipped: 0,
    maturityCreated: 0,
    maturitySkipped: 0,
    layoutImported: false,
    errors: [],
    unplaced: [],
  };

  const items = (cellar.bottles || []).map(exportBottleToItem);
  const imagesByIndex = (cellar.bottles || []).map((b) => (Array.isArray(b.images) ? b.images : []));

  // 1. Resolve the target. For an OVERWRITE we do NOT touch the live cellar yet:
  //    we build the whole replacement into a throwaway staging cellar and only
  //    swap it in once the import has fully succeeded (see swapCellarContents).
  //    That way a mid-import crash/OOM/throw can never destroy the user's
  //    existing bottles, photos, history or 3D layout. For a CREATE we build
  //    straight into the user's new cellar, as before.
  let liveCellar = null;
  if (opts.mode === 'overwrite') {
    liveCellar = await Cellar.findOne({ user: userId, name: opts.targetName, deletedAt: null });
  }
  const buildCellar = liveCellar
    ? await Cellar.create({ user: userId, name: stagingCellarName(), description: cellar.description || '' })
    : await Cellar.create({ user: userId, name: opts.targetName, description: cellar.description || '' });
  if (!liveCellar) result.mode = 'create';

  // 2. Build everything into buildCellar; 3. swap onto the live cellar (overwrite).
  let createdActiveIds = [];
  let swapStarted = false;
  try {
    createdActiveIds = await buildCellarContents({
      cellarId: buildCellar._id, ownerId: buildCellar.user, userId, cellar,
      items, imagesByIndex, anchor, getFileBuffer,
      defaultCurrency: opts.defaultCurrency, result,
    });
    if (liveCellar) {
      swapStarted = true;
      await swapCellarContents(liveCellar, buildCellar, cellar.description || '');
    }
  } catch (err) {
    // The build failed BEFORE the swap began: the live cellar is fully intact and
    // the staging cellar is a pure throwaway, so discard it and surface the error
    // — no user data is lost. (In create mode buildCellar IS the user's new
    // cellar; leave the partial result, matching the prior behaviour.)
    if (liveCellar && !swapStarted) {
      try {
        await clearCellarContents(buildCellar._id);
        await Cellar.deleteOne({ _id: buildCellar._id });
      } catch (cleanupErr) {
        console.warn('[cellarImport] staging cleanup failed:', cleanupErr.message);
      }
    } else if (liveCellar) {
      // Failure DURING the swap (a DB error between clearing the live cellar and
      // re-homing the new content). The replacement data still lives in the
      // staging cellar — do NOT delete it, so nothing is lost and it can be
      // recovered. Leave a loud breadcrumb.
      console.error(`[cellarImport] swap interrupted for user ${userId}; recover data from staging cellar ${buildCellar._id}:`, err.message);
    }
    throw err;
  }

  // 4. Index the new active bottles (fire-and-forget) — after any swap so their
  //    cellar pointer is final.
  if (createdActiveIds.length) searchService.bulkIndexBottles(createdActiveIds);

  return result;
}

module.exports = {
  parseCellarExport,
  archivePathToUrl,
  resolveTargets,
  exportBottleToItem,
  attachMaturity,
  importCellar,
  clearCellarContents,
  EXPORT_SCHEMA,
  MAX_IMAGES_PER_BOTTLE,
  MAX_IMPORT_CELLARS,
  MAX_IMPORT_BOTTLES,
};
