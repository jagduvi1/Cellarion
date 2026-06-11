const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');

const WINE_SELECT = 'name producer type appellation country region grapes classification';
const WINE_POPULATE = [
  { path: 'country', select: 'name' },
  { path: 'region', select: 'name' },
  { path: 'grapes', select: 'name' },
];

/** Canonical key for a wine-list entry: wine + vintage + bottle size. */
function entryKey(entry) {
  return `${entry.wine}|${entry.vintage || 'NV'}|${entry.bottleSize || '750ml'}`;
}

/** Iterate all entries of a wine list regardless of structure mode. */
function allEntries(wineList) {
  if (wineList.structureMode === 'custom') {
    return (wineList.sections || []).flatMap(s => s.entries || []);
  }
  return wineList.autoGroupEntries || [];
}

/**
 * Aggregate the cellar's active bottles per wine + vintage + bottle size.
 * Returns Map<entryKey, { stock, avgPrice }>. Stock is scoped to the list's
 * cellar — entry wine IDs reference the shared registry, but counts and
 * purchase prices must never leak from other cellars.
 */
async function loadStockMap(cellarId) {
  const groups = await Bottle.aggregate([
    {
      $match: {
        cellar: new mongoose.Types.ObjectId(String(cellarId)),
        status: 'active',
        wineDefinition: { $ne: null },
      },
    },
    {
      $group: {
        _id: {
          wine: '$wineDefinition',
          vintage: { $ifNull: ['$vintage', 'NV'] },
          bottleSize: { $ifNull: ['$bottleSize', '750ml'] },
        },
        stock: { $sum: 1 },
        avgPrice: { $avg: '$price' },
      },
    },
  ]);

  const map = new Map();
  for (const g of groups) {
    const key = entryKey({ wine: g._id.wine, vintage: g._id.vintage, bottleSize: g._id.bottleSize });
    map.set(key, { stock: g.stock, avgPrice: g.avgPrice != null ? g.avgPrice : null });
  }
  return map;
}

/**
 * Load everything needed to render a wine list: populated WineDefinitions for
 * every entry plus per-entry stock from the list's cellar.
 *
 * Returns Map<entryKey, { wine, stock, avgPrice }> — entries whose wine no
 * longer exists in the registry are simply absent.
 */
async function loadWineMap(wineList) {
  const wineIds = new Set();
  for (const entry of allEntries(wineList)) {
    if (entry.wine) wineIds.add(entry.wine.toString());
  }

  const [wines, stockMap] = await Promise.all([
    WineDefinition.find({ _id: { $in: [...wineIds] } })
      .select(WINE_SELECT)
      .populate(WINE_POPULATE)
      .lean(),
    loadStockMap(wineList.cellar),
  ]);

  const wineById = new Map(wines.map(w => [w._id.toString(), w]));

  const map = new Map();
  for (const entry of allEntries(wineList)) {
    const key = entryKey(entry);
    if (map.has(key)) continue;
    const wine = entry.wine && wineById.get(entry.wine.toString());
    if (!wine) continue;
    const stock = stockMap.get(key) || { stock: 0, avgPrice: null };
    map.set(key, { wine, stock: stock.stock, avgPrice: stock.avgPrice });
  }
  return map;
}

/**
 * All distinct wines in a cellar (active bottles grouped by wine + vintage +
 * size) with stock and average purchase price — the editor's picker data.
 */
async function loadCellarWines(cellarId) {
  const stockMap = await loadStockMap(cellarId);

  const wineIds = new Set();
  for (const key of stockMap.keys()) {
    wineIds.add(key.split('|')[0]);
  }
  const wines = await WineDefinition.find({ _id: { $in: [...wineIds] } })
    .select(WINE_SELECT)
    .populate(WINE_POPULATE)
    .lean();
  const wineById = new Map(wines.map(w => [w._id.toString(), w]));

  const result = [];
  for (const [key, { stock, avgPrice }] of stockMap) {
    const [wineId, vintage, bottleSize] = key.split('|');
    const wine = wineById.get(wineId);
    if (!wine) continue;
    result.push({ wine, vintage, bottleSize, stock, avgPrice });
  }

  // Stable, scannable picker order: name, vintage, size
  result.sort((a, b) =>
    (a.wine.name || '').localeCompare(b.wine.name || '') ||
    (a.vintage || '').localeCompare(b.vintage || '') ||
    (a.bottleSize || '').localeCompare(b.bottleSize || '')
  );
  return result;
}

module.exports = { entryKey, allEntries, loadWineMap, loadCellarWines };
