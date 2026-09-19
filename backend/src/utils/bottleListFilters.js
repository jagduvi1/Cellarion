/**
 * Bottle-list helpers shared by the cellar views (GET /api/cellars/:id and
 * GET /api/cellars/multi/bottles).
 *
 * The Statistics page's charts deep-link into the cellar view (support ticket
 * 2026-09-19: the separate /bottles drill-down list had no grouping, sorting,
 * list view or photos — everything the cellar view already has). The charts
 * speak in NAMES (a country bar is "Italy", a grape bar "Nebbiolo") and filter
 * on producer / bottle size / purchase year, which the cellar views did not
 * know. These helpers teach them, with the same semantics GET /api/bottles
 * has always used for the same params.
 */
const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');

// A syntactically valid id nothing carries: a name that resolves to no row
// must match NO bottles, and passing this through the normal id filters does
// exactly that on every path (Meilisearch and Mongo) without a special case.
const NO_MATCH_ID = '000000000000000000000000';

const TAXONOMY_PARAMS = [
  ['country', Country],
  ['region', Region],
  ['grapes', Grape],
];

/**
 * Rewrite ?country / ?region / ?grapes in place so every token is an id:
 * ids pass through, names are resolved (exact name match, as /api/bottles
 * does). Only touches plain-string params; the routes' own coercion handles
 * anything else. Resolves nothing — no query — when every token is an id.
 */
async function normalizeTaxonomyQuery(query) {
  for (const [key, Model] of TAXONOMY_PARAMS) {
    const raw = query[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const names = tokens.filter((t) => !mongoose.isValidObjectId(t));
    if (names.length === 0) continue;
    const ids = tokens.filter((t) => mongoose.isValidObjectId(t));
    const found = await Model.find({ name: { $in: names } }).distinct('_id');
    ids.push(...found.map(String));
    query[key] = (ids.length ? ids : [NO_MATCH_ID]).join(',');
  }
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ?producer (exact, case-insensitive), ?bottleSize (exact), ?purchaseYear
 * (calendar year of purchaseDate). Returns null when none is set, so callers
 * can keep their DB-paginated hot paths for the common unfiltered view.
 */
function parseExtraBottleFilters(query) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const producer = str(query.producer);
  const bottleSize = str(query.bottleSize);
  const yearRaw = str(query.purchaseYear);
  const year = yearRaw ? parseInt(yearRaw, 10) : null;
  const purchaseYear = Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
  if (!producer && !bottleSize && !purchaseYear) return null;
  return {
    producer: producer ? new RegExp(`^${escapeRegex(producer)}$`, 'i') : null,
    bottleSize,
    purchaseYear,
  };
}

/** Apply parseExtraBottleFilters' result to populated lean bottles. */
function applyExtraBottleFilters(bottles, extra) {
  if (!extra) return bottles;
  return bottles.filter((b) => {
    if (extra.producer && !extra.producer.test(b.wineDefinition?.producer || '')) return false;
    if (extra.bottleSize && (b.bottleSize || '750ml') !== extra.bottleSize) return false;
    if (extra.purchaseYear) {
      if (!b.purchaseDate) return false;
      if (new Date(b.purchaseDate).getFullYear() !== extra.purchaseYear) return false;
    }
    return true;
  });
}

/**
 * Collapse identical bottles — same wine + vintage + bottle size, and with
 * `byCellar` also the same cellar — preserving the input order (which is the
 * already-applied sort). Returns [{ key, bottles }]. A magnum and a 750ml of
 * the same wine stay apart; so, across cellars, do bottles in different
 * cellars: a group is something the user can act on in one place.
 */
function groupIdenticalBottles(bottles, { byCellar = false } = {}) {
  const groupMap = new Map();
  const order = [];
  for (const b of bottles) {
    const wineId = b.wineDefinition?._id
      ? b.wineDefinition._id.toString()
      : (b.wineDefinition ? b.wineDefinition.toString() : `none:${b._id}`);
    const key = `${byCellar ? `${b.cellar}::` : ''}${wineId}::${b.vintage || 'NV'}::${b.bottleSize || '750ml'}`;
    let arr = groupMap.get(key);
    if (!arr) { arr = []; groupMap.set(key, arr); order.push(key); }
    arr.push(b);
  }
  return order.map((key) => ({ key, bottles: groupMap.get(key) }));
}

module.exports = {
  NO_MATCH_ID,
  normalizeTaxonomyQuery,
  parseExtraBottleFilters,
  applyExtraBottleFilters,
  groupIdenticalBottles,
};
