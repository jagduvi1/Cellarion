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
 *  - entries whose bottle is gone or has no wine definition are dropped
 *    (they could never render — resolveEntry skipped them)
 *  - byGlass / glassPriceManual are set when the old list both had a glass
 *    price on the entry AND displayed glass prices (layout.showGlassPrice),
 *    preserving exactly what the published PDF showed before
 *
 * Idempotent: entries that already have a `wine` field are left untouched.
 * Run inside the backend container AFTER deploying the new code:
 *   docker exec cellarion-backend node src/scripts/migrate-wine-list-entries.js
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';

function migrateEntries(entries, bottleById, showGlassPrice) {
  const out = [];
  const seen = new Set();

  for (const entry of entries || []) {
    if (entry.wine) {
      // Already migrated — keep as-is (but still dedupe)
      const key = `${entry.wine}|${entry.vintage || 'NV'}|${entry.bottleSize || '750ml'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      continue;
    }
    if (!entry.bottle) continue;

    const bottle = bottleById.get(entry.bottle.toString());
    if (!bottle || !bottle.wineDefinition) continue;

    const vintage = bottle.vintage || 'NV';
    const bottleSize = bottle.bottleSize || '750ml';
    const key = `${bottle.wineDefinition}|${vintage}|${bottleSize}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const byGlass = showGlassPrice && entry.glassPrice != null;
    out.push({
      wine: bottle.wineDefinition,
      vintage,
      bottleSize,
      listPrice: entry.listPrice != null ? entry.listPrice : null,
      byGlass,
      glassPrice: entry.glassPrice != null ? entry.glassPrice : null,
      glassPriceManual: byGlass,
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

  const lists = await wineLists.find({}).toArray();
  console.log(`[migrate-wine-list-entries] ${lists.length} wine lists`);

  let migrated = 0;
  let skipped = 0;

  for (const list of lists) {
    const oldEntries = [
      ...(list.autoGroupEntries || []),
      ...(list.sections || []).flatMap(s => s.entries || []),
    ];
    if (!oldEntries.some(e => e.bottle && !e.wine)) {
      skipped++;
      continue;
    }

    const bottleIds = oldEntries.filter(e => e.bottle).map(e => e.bottle);
    const bottleDocs = await bottles
      .find({ _id: { $in: bottleIds } })
      .project({ wineDefinition: 1, vintage: 1, bottleSize: 1 })
      .toArray();
    const bottleById = new Map(bottleDocs.map(b => [b._id.toString(), b]));

    const showGlassPrice = list.layout?.showGlassPrice === true;
    const update = {
      $set: {
        autoGroupEntries: migrateEntries(list.autoGroupEntries, bottleById, showGlassPrice),
        sections: (list.sections || []).map(s => ({
          ...s,
          entries: migrateEntries(s.entries, bottleById, showGlassPrice),
        })),
      },
      $unset: { 'layout.showGlassPrice': '' },
    };

    await wineLists.updateOne({ _id: list._id }, update);
    migrated++;
  }

  console.log(`[migrate-wine-list-entries] Done: ${migrated} migrated, ${skipped} already current`);
  await mongoose.disconnect();
}

if (require.main === module) {
  migrate().catch(err => {
    console.error('[migrate-wine-list-entries] Failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateEntries };
