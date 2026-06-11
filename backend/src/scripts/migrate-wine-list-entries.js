/**
 * One-off migration: re-key wine list entries from physical bottles to wines.
 *
 * Old entry shape: { bottle: <Bottle id>, listPrice, glassPrice, sortOrder }
 * New entry shape: { wine: <WineDefinition id>, vintage, bottleSize,
 *                    listPrice, byGlass, glassPrice, glassPriceManual, sortOrder }
 *
 * Per list, per container (each custom section / the auto entry list):
 *  - each bottle entry is resolved to its bottle's wine + vintage + size
 *  - duplicates of the same wine collapse into one entry (first one wins)
 *  - an entry whose bottle was consumed is kept when the wine still has
 *    active stock in the cellar (the old per-bottle keying hid it by
 *    accident — the wine is genuinely available) and dropped when the wine
 *    is sold out (preserving what guests saw)
 *  - entries whose bottle is gone are dropped (they rendered nothing)
 *  - entries whose bottle has no wine definition (pending wine requests)
 *    CANNOT be represented in the new model and are dropped — the old
 *    renderer showed them as "Unknown Wine", so each one is logged loudly
 *    with its prices for the operator to re-add after the request resolves
 *  - glassPriceManual is set whenever a glass price exists: the old system
 *    had no auto-suggestion, so every stored glass price was hand-entered
 *    and must never be overwritten by the new pricing rule
 *  - byGlass additionally requires the old layout.showGlassPrice, so the
 *    published PDF shows exactly the glass prices it showed before
 *  - layout.hideOutOfStock is enabled on migrated lists: the old renderer
 *    auto-hid entries whose bottle was consumed, and this keeps sold-out
 *    wines off published menus going forward
 *
 * Safety: every list is copied to the `winelists_premigration_backup`
 * collection (once, $setOnInsert) before being modified, so any decision
 * above can be revisited.
 *
 * Idempotent: entries that already have a `wine` field are left untouched.
 * Run inside the backend container AFTER deploying the new code:
 *   docker exec cellarion-backend node src/scripts/migrate-wine-list-entries.js
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';

function entryKeyOf(wine, vintage, bottleSize) {
  return `${wine}|${vintage || 'NV'}|${bottleSize || '750ml'}`;
}

/**
 * @param {Array} entries - old-shape entries of one container
 * @param {Map} bottleById - bottleId → { wineDefinition, vintage, bottleSize, status }
 * @param {Object} opts
 * @param {boolean} opts.showGlassPrice - old layout.showGlassPrice
 * @param {Set<string>|null} opts.activeStockKeys - keys with active stock in
 *   the cellar; null disables the stock filter
 * @param {Function} [opts.onDrop] - called with (entry, reason) for each drop
 */
function migrateEntries(entries, bottleById, { showGlassPrice = false, activeStockKeys = null, onDrop = () => {} } = {}) {
  const out = [];
  const seen = new Set();

  for (const entry of entries || []) {
    if (entry.wine) {
      // Already migrated — keep as-is (but still dedupe)
      const key = entryKeyOf(entry.wine, entry.vintage, entry.bottleSize);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      continue;
    }
    if (!entry.bottle) continue;

    const bottle = bottleById.get(entry.bottle.toString());
    if (!bottle) {
      onDrop(entry, 'bottle-missing');
      continue;
    }
    if (!bottle.wineDefinition) {
      onDrop(entry, 'pending-wine-request');
      continue;
    }

    const vintage = bottle.vintage || 'NV';
    const bottleSize = bottle.bottleSize || '750ml';
    const key = entryKeyOf(bottle.wineDefinition, vintage, bottleSize);
    if (seen.has(key)) continue;

    // Consumed bottle: keep the wine only if it still has active stock
    if (bottle.status !== 'active' && activeStockKeys && !activeStockKeys.has(key)) {
      onDrop(entry, 'sold-out');
      continue;
    }
    seen.add(key);

    const hasGlassPrice = entry.glassPrice != null;
    out.push({
      wine: bottle.wineDefinition,
      vintage,
      bottleSize,
      listPrice: entry.listPrice != null ? entry.listPrice : null,
      byGlass: showGlassPrice && hasGlassPrice,
      glassPrice: hasGlassPrice ? entry.glassPrice : null,
      // Every pre-migration glass price was hand-entered (there was no
      // suggestion engine) — protect it from rule-based recalculation
      glassPriceManual: hasGlassPrice,
      sortOrder: out.length,
    });
  }
  return out;
}

async function migrate() {
  await mongoose.connect(MONGO_URI);
  console.log('[migrate-wine-list-entries] Connected to MongoDB');

  // Raw collections: the new schema no longer knows `entry.bottle` or
  // `layout.showGlassPrice`, so reads must bypass schema filtering.
  const wineLists = mongoose.connection.collection('winelists');
  const bottles = mongoose.connection.collection('bottles');
  const backups = mongoose.connection.collection('winelists_premigration_backup');

  const lists = await wineLists.find({}).toArray();
  console.log(`[migrate-wine-list-entries] ${lists.length} wine lists`);

  let migrated = 0;
  let skipped = 0;
  let droppedTotal = 0;

  for (const list of lists) {
    const oldEntries = [
      ...(list.autoGroupEntries || []),
      ...(list.sections || []).flatMap(s => s.entries || []),
    ];
    if (!oldEntries.some(e => e.bottle && !e.wine)) {
      skipped++;
      continue;
    }

    // Backup the untouched doc once — the rewrite below is destructive
    await backups.updateOne(
      { _id: list._id },
      { $setOnInsert: { ...list, backedUpAt: new Date() } },
      { upsert: true }
    );

    const bottleIds = oldEntries.filter(e => e.bottle).map(e => e.bottle);
    const bottleDocs = await bottles
      .find({ _id: { $in: bottleIds } })
      .project({ wineDefinition: 1, vintage: 1, bottleSize: 1, status: 1 })
      .toArray();
    const bottleById = new Map(bottleDocs.map(b => [b._id.toString(), b]));

    // Keys with active stock in this cellar — decides whether a wine whose
    // referenced bottle was consumed stays on the list
    const stockGroups = await bottles.aggregate([
      { $match: { cellar: list.cellar, status: 'active', wineDefinition: { $ne: null } } },
      { $group: { _id: {
        wine: '$wineDefinition',
        vintage: { $ifNull: ['$vintage', 'NV'] },
        bottleSize: { $ifNull: ['$bottleSize', '750ml'] },
      } } },
    ]).toArray();
    const activeStockKeys = new Set(
      stockGroups.map(g => entryKeyOf(g._id.wine, g._id.vintage, g._id.bottleSize))
    );

    const onDrop = (entry, reason) => {
      droppedTotal++;
      const detail = `listPrice=${entry.listPrice ?? '-'} glassPrice=${entry.glassPrice ?? '-'} bottle=${entry.bottle}`;
      if (reason === 'pending-wine-request') {
        console.warn(`[migrate-wine-list-entries] DROPPED (pending wine request, re-add manually after the request resolves): list "${list.name}" (${list._id}) — ${detail}`);
      } else {
        console.log(`[migrate-wine-list-entries] dropped (${reason}): list "${list.name}" (${list._id}) — ${detail}`);
      }
    };

    const opts = { showGlassPrice: list.layout?.showGlassPrice === true, activeStockKeys, onDrop };
    const update = {
      $set: {
        autoGroupEntries: migrateEntries(list.autoGroupEntries, bottleById, opts),
        sections: (list.sections || []).map(s => ({
          ...s,
          entries: migrateEntries(s.entries, bottleById, opts),
        })),
        // The old renderer auto-hid entries whose bottle was consumed —
        // keep sold-out wines off published menus going forward too
        'layout.hideOutOfStock': true,
      },
      $unset: { 'layout.showGlassPrice': '' },
    };

    await wineLists.updateOne({ _id: list._id }, update);
    migrated++;
  }

  console.log(`[migrate-wine-list-entries] Done: ${migrated} migrated, ${skipped} already current, ${droppedTotal} entries dropped (originals in winelists_premigration_backup)`);
  await mongoose.disconnect();
}

if (require.main === module) {
  migrate().catch(err => {
    console.error('[migrate-wine-list-entries] Failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateEntries };
