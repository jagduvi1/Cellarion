/**
 * Cellar data-portability export.
 *
 * Powers the "take your cellars with you" feature: a user can pull one cellar
 * (or all of their owned cellars) out of Cellarion in a self-describing,
 * import-ready format, optionally bundled with the image files THEY uploaded —
 * so they can stand up their own Cellarion instance and load everything back.
 * This is the anti-lock-in promise made concrete.
 *
 * The per-bottle shape is deliberately identical to the columns the CSV
 * importer understands: wineName/producer/vintage/rackName/rackPosition/…
 * So an export round-trips through the existing import path with no new
 * mapping.
 *
 * Image rule: only files where `uploadedBy === the requesting user` are
 * included. Photos other people contributed (e.g. a shared wine's label) are
 * never bundled — the user only gets their own uploads.
 */
const fs = require('fs');
const archiver = require('archiver');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const BottleImage = require('../models/BottleImage');
const CellarLayout = require('../models/CellarLayout');
const Review = require('../models/Review');
const User = require('../models/User');
const { buildProfileMap } = require('../utils/maturityUtils');
const { safeUploadPath } = require('./imageProcessor');

// Bound worst-case memory: a single export can't materialise more than this
// many bottles/images. Far above any real cellar; a hit is flagged via
// payload._truncated so an outlier knows to contact support.
const EXPORT_MAX = 50000;

/**
 * Map a stored image URL to its path inside the export archive.
 *   '/api/uploads/originals/uuid.jpg' → 'images/originals/uuid.jpg'
 * Returns null for anything that isn't a local upload (e.g. a remote URL or a
 * null processedUrl), so callers can skip it.
 */
function urlToArchivePath(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/api/uploads/')) return null;
  return `images/${url.replace('/api/uploads/', '')}`;
}

/**
 * Pure: turn raw (populated) bottles + racks into import-aligned export items.
 *
 * @param bottles         lean Bottle docs with `wineDefinition` populated
 *                        (country/region populated as { name }).
 * @param racks           lean Rack docs (for slot → rack placement).
 * @param imagesByBottle  Map<bottleIdString, BottleImage[]> — the user's own
 *                        images, grouped by bottle. Empty/omitted → no `images`
 *                        key is emitted (matches the legacy no-images export).
 * @param reviewsByBottle Map<bottleIdString, Review[]> — the user's own reviews
 *                        tied to the bottle. Empty/omitted → no `reviews` key.
 * @param profilesByWineVintage Map<`${wineDefId}:${vintage}`, WineVintageProfile>
 *                        — reviewed sommelier maturity windows (from
 *                        utils/maturityUtils buildProfileMap). Empty/omitted → no
 *                        `maturity` key is emitted.
 */
function mapBottlesForExport(bottles, racks, imagesByBottle = new Map(), reviewsByBottle = new Map(), profilesByWineVintage = new Map()) {
  // bottleId → placement. `rackPosition` (the internal 1-indexed slot) is the
  // source of truth and round-trips for every rack type on re-import. rackRow /
  // rackCol are a human-readable convenience that is only correct for plain grid
  // racks — the simple cols-based math is wrong for shelf / x-rack / hex / …
  // (whose per-row stride differs), so only emit them for grids and never let an
  // importer rely on them.
  const bottleRackMap = new Map();
  for (const rack of racks) {
    const isGrid = (rack.type || 'grid') === 'grid';
    for (const slot of rack.slots || []) {
      if (!slot || !slot.bottle) continue;
      const entry = { rackName: rack.name, rackPosition: slot.position };
      if (isGrid && rack.cols) {
        entry.rackRow = Math.ceil(slot.position / rack.cols);
        entry.rackCol = ((slot.position - 1) % rack.cols) + 1;
      }
      bottleRackMap.set(slot.bottle.toString(), entry);
    }
  }

  return bottles.map((b) => {
    const wine = b.wineDefinition || {};
    const item = {
      wineName: wine.name || '',
      producer: wine.producer || '',
      vintage: b.vintage || 'NV',
      country: wine.country?.name || '',
      region: wine.region?.name || '',
      appellation: wine.appellation || '',
      type: wine.type || '',
      // Grape varieties (names only) so the importer can reconstruct them via
      // findOrCreateGrapes on a cross-instance migration — otherwise every
      // auto-created wine lands with an empty grape list.
      grapes: Array.isArray(wine.grapes) ? wine.grapes.map((g) => g.name).filter(Boolean) : [],
      bottleSize: b.bottleSize || '750ml',
      dateAdded: b.createdAt ? b.createdAt.toISOString().slice(0, 10) : undefined,
    };

    // Cellar journey (added → moved between cellars). Cellar names + dates only —
    // the cellar ObjectIds are instance-local and don't transfer — so the
    // per-bottle history survives an export → import round-trip.
    if (b.addedToCellarAt) item.addedToCellarAt = b.addedToCellarAt.toISOString();
    if (Array.isArray(b.cellarHistory) && b.cellarHistory.length) {
      item.cellarHistory = b.cellarHistory.map((h) => ({
        cellarName: h.cellarName || '',
        enteredAt: h.enteredAt ? h.enteredAt.toISOString() : undefined,
      }));
    }

    // User-entered pricing
    if (b.price != null) {
      item.price = b.price;
      item.currency = b.currency || 'USD';
    }

    // User-entered purchase info
    if (b.purchaseDate) item.purchaseDate = b.purchaseDate.toISOString().slice(0, 10);
    if (b.purchaseLocation) item.purchaseLocation = b.purchaseLocation;
    if (b.purchaseUrl) item.purchaseUrl = b.purchaseUrl;
    if (b.location) item.location = b.location;
    if (b.notes) item.notes = b.notes;

    // Personal per-bottle drink window (the USER'S own intent, distinct from the
    // sommelier `maturity` window below) + the occasion note. Additive fields the
    // importer already consumes — emitted only when present so a bottle without
    // them round-trips to the same (absent) state. Omitting these dropped the
    // user's drink window on every export → import round-trip.
    if (b.drinkFrom != null) item.drinkFrom = b.drinkFrom;
    if (b.drinkTo != null) item.drinkTo = b.drinkTo;
    if (b.occasion) item.occasion = b.occasion;

    // User-entered rating
    if (b.rating != null) {
      item.rating = b.rating;
      item.ratingScale = b.ratingScale || '5';
    }

    // Rack placement
    const rackInfo = bottleRackMap.get(b._id.toString());
    if (rackInfo) {
      item.rackName = rackInfo.rackName;
      item.rackPosition = rackInfo.rackPosition;
      if (rackInfo.rackRow != null) item.rackRow = rackInfo.rackRow;
      if (rackInfo.rackCol != null) item.rackCol = rackInfo.rackCol;
    }

    // Open-bottle (Coravin / preservation) state — rides along so a migration
    // doesn't lose the fact that a bottle is open and part-drunk.
    if (b.openedAt) {
      item.openedAt = b.openedAt.toISOString();
      if (b.preservationMethod) item.preservationMethod = b.preservationMethod;
      if (Array.isArray(b.pours) && b.pours.length > 0) {
        item.pours = b.pours.map((p) => ({ at: p.at ? p.at.toISOString() : undefined, ml: p.ml }));
      }
    }

    // Consumed / history bottles
    if (b.status && b.status !== 'active') {
      item.addToHistory = true;
      item.consumedReason = b.consumedReason || b.status;
      if (b.consumedAt) item.consumedAt = b.consumedAt.toISOString().slice(0, 10);
      if (b.consumedNote) item.consumedNote = b.consumedNote;
      if (b.consumedRating != null) {
        item.consumedRating = b.consumedRating;
        item.consumedRatingScale = b.consumedRatingScale || '5';
      }
    }

    // The user's own images for this bottle — referenced by their in-archive
    // path so they line up with the files bundled in the ZIP. In a data-only
    // (JSON) export the files aren't present, but the paths still tell the user
    // (and a future importer) exactly which images belong to which bottle.
    //
    // Only the CROPPED / background-removed image is exported. The pre-crop
    // original is never included (it's the version we keep, and for moderated
    // images the original is already deleted on approval). We fall back to the
    // original only when there is no processed version at all, so an image is
    // never silently dropped from the export.
    const imgs = imagesByBottle.get(b._id.toString()) || [];
    if (imgs.length) {
      item.images = imgs
        .map((i) => {
          const processed = urlToArchivePath(i.processedUrl);
          const original = processed ? null : urlToArchivePath(i.originalUrl);
          if (!processed && !original) return null;
          const entry = {};
          if (processed) entry.processed = processed;
          else entry.original = original;
          if (i.credit) entry.credit = i.credit;
          return entry;
        })
        .filter(Boolean);
      if (item.images.length === 0) delete item.images;
    }

    // The user's own reviews tied to this bottle (community wine reviews +
    // their grade + tasting notes). Re-created on import against the resolved
    // wine + new bottle.
    const reviews = reviewsByBottle.get(b._id.toString()) || [];
    if (reviews.length) {
      item.reviews = reviews.map((r) => ({
        rating: r.rating,
        ratingScale: r.ratingScale,
        vintage: r.vintage || undefined,
        tasting: r.tasting || undefined,
        visibility: r.visibility || 'public',
        createdAt: r.createdAt,
      }));
    }

    // Sommelier-curated maturity window for this bottle's wine + vintage. Shared
    // across all bottles of the same wine+vintage, so it's denormalised onto each
    // bottle to keep the per-bottle import path. Raw stored values are emitted
    // (the `relative` flag plus phase years, or year-offsets when relative) so the
    // window re-creates identically on import — no resolution to absolute years.
    const wdId = wine?._id?.toString();
    if (wdId && b.vintage && b.vintage !== 'NV') {
      const profile = profilesByWineVintage.get(`${wdId}:${b.vintage}`);
      if (profile) {
        const m = {};
        if (profile.relative) m.relative = true;
        for (const k of ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil']) {
          if (profile[k] != null) m[k] = profile[k];
        }
        if (profile.sommNotes) m.sommNotes = profile.sommNotes;
        // Only emit when an actual window is present — a reviewed-but-empty profile
        // carries no useful data and would just be noise in the export.
        if (Object.keys(m).some((k) => k !== 'relative')) item.maturity = m;
      }
    }

    return item;
  });
}

/**
 * Collect the unique on-disk image files to bundle into the ZIP, de-duplicated
 * by archive path. Mirrors mapBottlesForExport's selection: only the CROPPED
 * (processed) file is bundled; the pre-crop original is taken only as a fallback
 * when an image has no processed version. Returns [{ relPath, archivePath }]
 * where relPath is relative to the uploads root (for safeUploadPath) and
 * archivePath is where the file lives inside the export ZIP.
 */
function collectImageFiles(images) {
  const files = [];
  const seen = new Set();
  for (const img of images) {
    // Prefer the processed (cropped) file; fall back to the original only if
    // there is no processed version — never bundle the original alongside it.
    const url = img.processedUrl || img.originalUrl;
    const archivePath = urlToArchivePath(url);
    if (!archivePath || seen.has(archivePath)) continue;
    seen.add(archivePath);
    files.push({ relPath: url.replace('/api/uploads/', ''), archivePath });
  }
  return files;
}

/**
 * Build the export for a user, scoped to one owned cellar or all owned cellars.
 *
 * Owner-only by design: you can only take a cellar to your own instance if it's
 * yours. Cellars owned by someone else (where the user is just a member) are
 * not exportable here.
 *
 * @returns null if the scope resolves to no owned cellar (bad id / not owner),
 *          else { payload, imageFiles, imageCount } where payload is the JSON
 *          document, imageFiles is the disk-file list for the ZIP, and
 *          imageCount is how many of the user's own images are in scope.
 */
async function buildCellarDataExport(userId, scope) {
  const ownerFilter = { user: userId, deletedAt: null };
  let cellars;
  if (scope === 'all') {
    cellars = await Cellar.find(ownerFilter).sort({ createdAt: 1 }).lean();
  } else {
    const one = await Cellar.findOne({ _id: scope, ...ownerFilter }).lean();
    cellars = one ? [one] : [];
  }
  if (cellars.length === 0) return null;

  const cellarIds = cellars.map((c) => c._id);
  const [bottles, racks] = await Promise.all([
    Bottle.find({ cellar: { $in: cellarIds } })
      .populate({
        path: 'wineDefinition',
        populate: [
          { path: 'country', select: 'name' },
          { path: 'region', select: 'name' },
          { path: 'grapes', select: 'name' },
        ],
        select: 'name producer type appellation country region grapes',
      })
      .limit(EXPORT_MAX)
      .lean(),
    Rack.find({ cellar: { $in: cellarIds }, deletedAt: null }).lean(),
  ]);

  // Only the user's OWN uploaded images + reviews, for the bottles in scope.
  const bottleIds = bottles.map((b) => b._id);
  const [images, reviews, layouts] = await Promise.all([
    bottleIds.length
      ? BottleImage.find({ uploadedBy: userId, bottle: { $in: bottleIds } })
          .select('bottle originalUrl processedUrl credit createdAt').limit(EXPORT_MAX).lean()
      : [],
    bottleIds.length
      ? Review.find({ author: userId, bottle: { $in: bottleIds } })
          .select('bottle rating ratingScale vintage tasting visibility createdAt').limit(EXPORT_MAX).lean()
      : [],
    // The 3D room arrangement (one CellarLayout per cellar).
    CellarLayout.find({ cellar: { $in: cellarIds } }).lean(),
  ]);

  // Group bottles, racks, images and reviews by cellar / bottle.
  const imagesByBottle = new Map();
  for (const img of images) {
    const key = img.bottle?.toString();
    if (!key) continue;
    if (!imagesByBottle.has(key)) imagesByBottle.set(key, []);
    imagesByBottle.get(key).push(img);
  }
  const reviewsByBottle = new Map();
  for (const rev of reviews) {
    const key = rev.bottle?.toString();
    if (!key) continue;
    if (!reviewsByBottle.has(key)) reviewsByBottle.set(key, []);
    reviewsByBottle.get(key).push(rev);
  }
  // Reviewed maturity windows for every wine+vintage in scope, keyed
  // `${wineDefId}:${vintage}` (shared helper with the stats/chat maturity code).
  const profilesByWineVintage = await buildProfileMap(bottles);
  const bottlesByCellar = new Map();
  for (const b of bottles) {
    const key = b.cellar.toString();
    if (!bottlesByCellar.has(key)) bottlesByCellar.set(key, []);
    bottlesByCellar.get(key).push(b);
  }
  const racksByCellar = new Map();
  const rackIdToName = new Map();
  for (const r of racks) {
    rackIdToName.set(r._id.toString(), r.name);
    const key = r.cellar.toString();
    if (!racksByCellar.has(key)) racksByCellar.set(key, []);
    racksByCellar.get(key).push(r);
  }
  // 3D room layout per cellar — rack placements re-keyed by rack NAME so they
  // survive across instances (the rack ObjectIds won't).
  const layoutByCellar = new Map();
  for (const lay of layouts) {
    layoutByCellar.set(lay.cellar.toString(), lay);
  }

  const cellarPayloads = cellars.map((c) => {
    const id = c._id.toString();
    const layoutDoc = layoutByCellar.get(id);
    const layout = layoutDoc ? {
      roomDimensions: layoutDoc.roomDimensions,
      rackPlacements: (layoutDoc.rackPlacements || [])
        .map((p) => {
          const rackName = rackIdToName.get(p.rack?.toString());
          if (!rackName) return null; // placement for a rack not in scope
          return {
            rackName,
            position: p.position,
            rotation: p.rotation,
            wall: p.wall,
            ...(p.group ? { group: p.group } : {}),
            ...(p.widthOverride != null ? { widthOverride: p.widthOverride } : {}),
            ...(p.depthOverride != null ? { depthOverride: p.depthOverride } : {}),
            ...(p.scaleOverride != null ? { scaleOverride: p.scaleOverride } : {}),
          };
        })
        .filter(Boolean),
    } : null;

    return {
      cellarName: c.name,
      description: c.description || '',
      // Rack geometry so an import recreates the racks exactly (positions are
      // Cellarion's internal 1-indexed slots — see mapBottlesForExport — so with
      // the same geometry + top-left anchor the import round-trips placement).
      racks: (racksByCellar.get(id) || []).map((r) => ({
        name: r.name,
        type: r.type,
        rows: r.rows,
        cols: r.cols,
        ...(r.typeConfig ? { typeConfig: r.typeConfig } : {}),
        ...(Array.isArray(r.disabledPositions) && r.disabledPositions.length > 0
          ? { disabledPositions: r.disabledPositions }
          : {}),
        ...(Array.isArray(r.zones) && r.zones.length > 0
          ? { zones: r.zones.map((z) => ({ name: z.name, color: z.color, positions: z.positions })) }
          : {}),
      })),
      ...(layout ? { layout } : {}),
      bottles: mapBottlesForExport(
        bottlesByCellar.get(id) || [],
        racksByCellar.get(id) || [],
        imagesByBottle,
        reviewsByBottle,
        profilesByWineVintage
      ),
    };
  });

  const payload = {
    schema: 'cellarion-export@1',
    exportedAt: new Date().toISOString(),
    scope: scope === 'all' ? 'all' : String(scope),
    cellarCount: cellarPayloads.length,
    bottleCount: bottles.length,
    imageCount: images.length,
    reviewCount: reviews.length,
    maturityCount: profilesByWineVintage.size,
    cellars: cellarPayloads,
  };
  if (bottles.length >= EXPORT_MAX) {
    payload._truncated = EXPORT_MAX;
    console.warn(`[cellarExport] truncation hit for user ${userId} scope ${scope} (${EXPORT_MAX})`);
  }

  return { payload, imageFiles: collectImageFiles(images), imageCount: images.length };
}

/** README bundled into the ZIP so the archive is self-explanatory. */
const EXPORT_README = `# Cellarion export

This archive is a portable copy of your cellar(s) from Cellarion. It is yours to
keep, move to your own self-hosted Cellarion instance, or open in any tool that
reads JSON — Cellarion never locks your data in.

## Contents

- \`data.json\` — your cellars, racks (and their 3D room layout), bottles with
  their grades and rack placements, your reviews of those bottles, the
  sommelier-curated maturity (drink-window) data for each wine + vintage, and
  image references. The bottle fields match Cellarion's CSV/JSON importer.
- \`images/\` — the cropped (background-removed) image files **you uploaded**.
  The pre-crop originals are not included — only the finished image you kept.
  Images other people contributed (for example a shared wine's label) are not
  included either. Each bottle in \`data.json\` lists its images by their path
  inside this folder, e.g. \`images/processed/<id>.png\`.

## data.json shape

\`\`\`
{
  "schema": "cellarion-export@1",
  "exportedAt": "<ISO timestamp>",
  "scope": "all" | "<cellarId>",
  "cellars": [
    {
      "cellarName": "...",
      "description": "...",
      "bottles": [
        {
          "wineName": "...", "producer": "...", "vintage": "...",
          "rackName": "...", "rackPosition": 1, "rackRow": 1, "rackCol": 1,
          "maturity": { "peakFrom": 2026, "peakUntil": 2032, "lateUntil": 2038 },
          "images": [{ "processed": "images/processed/<id>.png" }]
        }
      ]
    }
  ]
}
\`\`\`

## Importing

In any Cellarion instance, go to **Cellars → Import** (or Settings → "Take your
cellars with you" → Import a cellar) and upload this file:

- Upload this **.zip** to restore everything, including the image files.
- Or upload just the **data.json** to import bottles, racks and placements
  without images.

Keep a cellar's name to **replace** an existing cellar of that name, or change
it to **create a new one**. Wines are matched against the destination's registry
and auto-created when missing; an image you already have isn't stored twice.
`;

// ── Full-export weekly allowance + ZIP streaming ─────────────────────────────
// Extracted from routes/users.js so the web full-export route AND the MCP
// export-link redeem route run ONE implementation of the expensive image
// archive: same weekly claim, same atomic-refund guards, same streaming. The
// allowance lives on User.lastImageExportAt so it is per-account and survives
// restarts (not per-IP like the global limiters), and the two surfaces share it
// — MCP is not a bypass of the weekly cap.
const IMAGE_EXPORT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Atomically claim this user's weekly image-export allowance BEFORE the
 * expensive build, so two concurrent requests can't both kick off a large
 * archive. Replaces a non-atomic check-then-set that was bypassable under
 * concurrency.
 * @returns {Promise<{claimed:true, claimStamp:Date, priorStamp:Date|null}
 *                   | {claimed:false, nextAvailableAt:Date}
 *                   | {claimed:false, notFound:true}>}
 */
async function claimImageExportAllowance(userId) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - IMAGE_EXPORT_COOLDOWN_MS);
  const claimed = await User.findOneAndUpdate(
    { _id: userId, $or: [{ lastImageExportAt: null }, { lastImageExportAt: { $lte: cutoff } }] },
    { $set: { lastImageExportAt: now } },
    { new: false } // pre-update doc, so we can read (and refund) the prior timestamp
  );
  if (claimed) return { claimed: true, claimStamp: now, priorStamp: claimed.lastImageExportAt };
  const u = await User.findById(userId).select('lastImageExportAt');
  if (!u) return { claimed: false, notFound: true };
  return {
    claimed: false,
    nextAvailableAt: new Date(new Date(u.lastImageExportAt).getTime() + IMAGE_EXPORT_COOLDOWN_MS),
  };
}

/**
 * Give back a claimed weekly allowance (nothing chargeable, or a build failure).
 * Guarded on OUR OWN claim timestamp so a later legitimate claim is never
 * clobbered.
 */
async function refundImageExportAllowance(userId, claimStamp, priorStamp) {
  if (!claimStamp) return;
  await User.updateOne(
    { _id: userId, lastImageExportAt: claimStamp },
    { $set: { lastImageExportAt: priorStamp ?? null } }
  );
}

/**
 * Pipe a cellar export payload + the user's own image files to `res` as a ZIP.
 * Sets no status/headers itself beyond the archive content type — the caller
 * owns response headers (filename differs per surface). Resolves when the
 * archive is finalised; rejects only on a pre-stream error the caller can still
 * turn into a 500 (once piping starts, headers are sent and we can only tear
 * the socket down).
 */
function streamCellarArchive(res, payload, imageFiles) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    let settled = false;
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') console.warn('[full-export] archive warning:', err.message);
    });
    archive.on('error', (err) => {
      console.error('[full-export] archive error:', err.message);
      if (settled) { res.destroy(err); return; }
      settled = true;
      reject(err);
    });
    archive.pipe(res);

    archive.append(JSON.stringify(payload, null, 2), { name: 'data.json' });
    archive.append(EXPORT_README, { name: 'README.md' });

    // Append each on-disk file. safeUploadPath blocks path traversal; a missing
    // file is skipped (the DB row can outlive a file that failed to write).
    for (const file of imageFiles) {
      let diskPath;
      try {
        diskPath = safeUploadPath(file.relPath);
      } catch {
        continue;
      }
      if (fs.existsSync(diskPath)) archive.file(diskPath, { name: file.archivePath });
    }

    archive.on('end', () => { if (!settled) { settled = true; resolve(); } });
    archive.finalize().catch((err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

module.exports = {
  buildCellarDataExport,
  mapBottlesForExport,
  collectImageFiles,
  urlToArchivePath,
  EXPORT_README,
  EXPORT_MAX,
  IMAGE_EXPORT_COOLDOWN_MS,
  claimImageExportAllowance,
  refundImageExportAllowance,
  streamCellarArchive,
};
