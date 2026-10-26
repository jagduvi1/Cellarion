const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const { DRAFT_EXCLUDED } = require('./wineVisibility');
const { getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');
const { normalizeCurrency } = require('../config/currencies');

const WINE_SELECT = 'name producer type nonWine appellation country region grapes classification';
const WINE_POPULATE = [
  { path: 'country', select: 'name translations' },
  { path: 'region', select: 'name translations' },
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
 * Average purchase price of one entry from its per-currency price totals
 * (Map<currency, { sum, n }>, priced bottles only) — see loadStockMap.
 */
function averagePrice(prices, currency, rates) {
  if (prices.size === 0) return null;
  if (prices.size === 1) {
    const [[from, { sum, n }]] = prices;
    if (!currency || from === normalizeCurrency(currency)) return sum / n;
  }
  if (!currency) return null;
  let total = 0;
  let count = 0;
  for (const [from, { sum, n }] of prices) {
    // convertCurrency reads 0 as nothing to convert; 0 is 0 in any currency.
    const converted = sum === 0 ? 0 : convertCurrency(sum, from, currency, rates);
    if (converted == null) return null;
    total += converted;
    count += n;
  }
  return total / count;
}

/**
 * Aggregate the cellar's active bottles per wine + vintage + bottle size.
 * Returns Map<entryKey, { stock, avgPrice }>. Stock is scoped to the list's
 * cellar — entry wine IDs reference the shared registry, but counts and
 * purchase prices must never leak from other cellars.
 *
 * Each price is in its bottle's own currency. An entry whose priced bottles
 * are all in `currency` (the list's) gets their plain average. Any other entry
 * — one foreign currency or several — gets the count-weighted average
 * converted into `currency` with today's rates, or null when a rate is
 * missing: no price beats a SEK figure printed as euros, or EUR and SEK added
 * up as one number. Without a `currency` (the editor's picker) an entry in
 * one currency keeps its plain average and a mixed one has none.
 *
 * @param {any} cellarId
 * @param {{ currency?: string }} [options]
 */
async function loadStockMap(cellarId, { currency } = {}) {
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
          currency: { $ifNull: ['$currency', 'USD'] },
        },
        stock: { $sum: 1 },
        priced: { $sum: { $cond: [{ $isNumber: '$price' }, 1, 0] } },
        priceSum: { $sum: '$price' },
      },
    },
  ]);

  // Fold the per-currency groups into one row per entry. A bottle without a
  // price still carries the default currency, so only priced groups count
  // towards an entry's currencies.
  const rows = new Map();
  for (const g of groups) {
    const key = entryKey({ wine: g._id.wine, vintage: g._id.vintage, bottleSize: g._id.bottleSize });
    const row = rows.get(key) || { stock: 0, prices: new Map() };
    row.stock += g.stock;
    if (g.priced > 0) {
      const cur = normalizeCurrency(g._id.currency);
      const p = row.prices.get(cur) || { sum: 0, n: 0 };
      p.sum += g.priceSum;
      p.n += g.priced;
      row.prices.set(cur, p);
    }
    rows.set(key, row);
  }

  // Rates are needed as soon as one priced bottle is in another currency than
  // the list's.
  const target = currency && normalizeCurrency(currency);
  let rates = null;
  if (target && [...rows.values()].some(r => [...r.prices.keys()].some(c => c !== target))) {
    try {
      rates = (await getOrCreateDailySnapshot())?.rates || null;
    } catch (_) { /* entries needing a conversion get no average */ }
  }

  const map = new Map();
  for (const [key, row] of rows) {
    map.set(key, { stock: row.stock, avgPrice: averagePrice(row.prices, currency, rates) });
  }
  return map;
}

/**
 * Which of `wineIds` may sit on this owner's wine lists: every published
 * registry wine, plus the pending-identity rows that are the owner's OWN —
 * created by them, or held by a bottle in a cellar they own or belong to (a
 * member's unread label in a shared cellar is still the owner's wine on the
 * owner's menu). A list is the owner's document about the owner's wines, so a
 * wine they see on their bottle page belongs on it like any other; the public
 * page then prints the row the way the bottle page does (name, no producer).
 *
 * Nothing else: a published list is served by routes/wineListPublic.js with
 * NO auth at all, so a stranger's hidden row must stay hidden there too. That
 * is why this is a QUERY filter rather than a post-filter — `pendingIdentity`
 * and `createdBy` are deliberately absent from WINE_SELECT, and a post-filter
 * reading an absent field would pass every row (services/wineVisibility
 * explains the trap). Shared by the renderer (loadWineMap) and the MCP
 * add_to_list lookup, so what can be added and what renders is one rule.
 *
 * @param {any} ownerId  the list owner (WineList.user)
 * @param {string[]} wineIds
 */
async function ownerWineFilter(ownerId, wineIds) {
  const ids = [...new Set(wineIds.map(String))];
  let held = [];
  if (ids.length) {
    const cellarIds = await Cellar.find({ $or: [{ user: ownerId }, { 'members.user': ownerId }], deletedAt: null }).distinct('_id');
    if (cellarIds.length) {
      held = await Bottle.distinct('wineDefinition', { cellar: { $in: cellarIds }, wineDefinition: { $in: ids } });
    }
  }
  return {
    _id: { $in: ids },
    $or: [
      { pendingIdentity: { $ne: true } },
      // The owner's own rows, their private drafts included: a draft is the
      // owner's wine too, and this is the owner's own menu.
      { pendingIdentity: true, createdBy: ownerId },
      // Held by a bottle in a cellar of theirs — a member's unread label — but
      // never another member's private draft: a draft stays creator-only on
      // every publish surface (services/wineVisibility, decision 2).
      { pendingIdentity: true, ...DRAFT_EXCLUDED, _id: { $in: held } },
    ],
  };
}

/**
 * Load everything needed to render a wine list: populated WineDefinitions for
 * every entry plus per-entry stock from the list's cellar.
 *
 * Returns Map<entryKey, { wine, stock, avgPrice }> — entries whose wine no
 * longer exists in the registry, or is a hidden row that is not the owner's
 * own (ownerWineFilter), are simply absent.
 */
async function loadWineMap(wineList) {
  const wineIds = new Set();
  for (const entry of allEntries(wineList)) {
    if (entry.wine) wineIds.add(entry.wine.toString());
  }

  const [wines, stockMap] = await Promise.all([
    ownerWineFilter(wineList.user, [...wineIds]).then(filter =>
      WineDefinition.find(filter)
        .select(WINE_SELECT)
        .populate(WINE_POPULATE)
        .lean()
    ),
    loadStockMap(wineList.cellar, { currency: wineList.layout?.currency || 'USD' }),
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
 * The picker belongs to no list, so it has no currency to convert into: a
 * wine whose bottles were bought in several currencies has no average here.
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

module.exports = { entryKey, allEntries, ownerWineFilter, loadWineMap, loadCellarWines };
