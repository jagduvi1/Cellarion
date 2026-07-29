/**
 * Garbage-collect a registry wine that an UNDONE action minted — the fix for
 * the launch-day report: undoing a bulk_add removed the bottles but left the
 * freshly-created WineDefinition and its auto-seeded pending maturity profile
 * orphaned in the somm queue.
 *
 * DELIBERATELY CONSERVATIVE. The registry is shared, so the wine is deleted
 * only when every guard agrees nothing else has grown around it:
 *   - zero bottles reference it (ANY user, ANY status — active or history);
 *   - no image has been approved as the wine's official photo
 *     (assignedToWine — an admin curated it; keep);
 *   - every maturity profile is still the auto-seeded 'pending' stub
 *     (a somm reviewed one → keep everything).
 * If any guard fails the wine simply stays — the undo of the bottles is
 * already complete and correct.
 *
 * Cleanup on success: pending profiles, the wine's un-approved images (rows +
 * files), embedding rows + their Qdrant points (best-effort), the Meilisearch
 * document, the WineDefinition itself, and a wine.undo_create audit entry.
 *
 * Callers pass wine ids their OWN ledger row recorded as created (add_bottle
 * detail.wine_created / bulk_add detail.createdWineIds) — never arbitrary ids.
 *
 * Returns { removed: boolean, reason?: string }. Never throws.
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const { logAudit } = require('./audit');

async function gcOrphanMintedWine(wineId, req) {
  try {
    if (!mongoose.isValidObjectId(wineId)) return { removed: false, reason: 'invalid id' };
    const wine = await WineDefinition.findById(wineId).select('name producer verifiedChecks');
    if (!wine) return { removed: false, reason: 'already gone' };

    const bottleCount = await Bottle.countDocuments({ wineDefinition: wineId });
    if (bottleCount > 0) return { removed: false, reason: `${bottleCount} bottle(s) still reference it` };

    const officialImage = await BottleImage.countDocuments({ wineDefinition: wineId, assignedToWine: true });
    if (officialImage > 0) return { removed: false, reason: 'has an approved wine image' };

    // Only a REVIEWED profile is curated data worth protecting. A deferred one
    // is a somm saying "this vintage isn't real yet" — on a wine that now has
    // no bottles at all, that is a reason to clean up, not to keep.
    const reviewedProfiles = await WineVintageProfile.countDocuments({
      wineDefinition: wineId,
      status: 'reviewed',
    });
    if (reviewedProfiles > 0) return { removed: false, reason: 'a maturity profile was reviewed' };

    // An admin cleared a data-quality check on this row — never let a user's
    // undo silently delete curated registry data.
    if ((wine.verifiedChecks || []).length > 0) {
      return { removed: false, reason: 'an admin verified a data-quality check on it' };
    }

    // Guards passed — clean up everything the mint created, quietest first.
    await WineVintageProfile.deleteMany({ wineDefinition: wineId, status: { $in: ['pending', 'deferred'] } });

    // Un-approved images (rows + files). unlinkImageFiles is best-effort.
    const images = await BottleImage.find({ wineDefinition: wineId });
    if (images.length) {
      const { unlinkImageFiles } = require('./imageProcessor');
      for (const img of images) {
        try { await unlinkImageFiles(img); } catch { /* file may already be gone */ }
      }
      await BottleImage.deleteMany({ wineDefinition: wineId });
    }

    // Embeddings: rows + Qdrant points, best-effort (the vector store may be
    // down; a stale point is harmless — searches dedupe against Mongo).
    try {
      const WineEmbedding = require('../models/WineEmbedding');
      const rows = await WineEmbedding.find({ wineDefinition: wineId }).select('qdrantPointId indexVersion').lean();
      if (rows.length) {
        const vectorStore = require('./vectorStore');
        const byIndex = new Map();
        for (const r of rows) {
          if (!r.qdrantPointId) continue;
          if (!byIndex.has(r.indexVersion)) byIndex.set(r.indexVersion, []);
          byIndex.get(r.indexVersion).push(r.qdrantPointId);
        }
        for (const [indexVersion, ids] of byIndex) {
          await vectorStore.deletePoints(indexVersion, ids).catch(() => {});
        }
        await WineEmbedding.deleteMany({ wineDefinition: wineId });
      }
    } catch { /* embedding cleanup is best-effort */ }

    require('./search').removeWine(wineId);
    await WineDefinition.deleteOne({ _id: wineId });

    logAudit(req, 'wine.undo_create',
      { type: 'wine', id: wineId },
      { name: wine.name, producer: wine.producer, via: 'undo' });

    return { removed: true };
  } catch (err) {
    // The bottles' undo already succeeded — a GC failure must never fail it.
    console.warn('[registryGc] gcOrphanMintedWine failed (non-fatal):', err.message);
    return { removed: false, reason: 'gc error' };
  }
}

module.exports = { gcOrphanMintedWine };
