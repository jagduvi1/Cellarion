// A history: the bottles that left a cellar, newest first, in sections by
// the reason they left. The order, the sections, the ?before cursor and the
// paging live here, for the two history routes in routes/cellars.js
// (GET /api/cellars/:id/history and GET /api/cellars/multi/history) and for
// the cross-cellar engine there, which orders and slices a searched history
// with the same functions. loadBottlesInOrder is also how the cellar list
// loads a ranked page.

const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const { parsePagination } = require('../utils/pagination');
const { WINE_POPULATE_LIST } = require('../config/constants');

// Populate bottles by id, in the given (ranked) order.
async function loadBottlesInOrder(ids, populate = WINE_POPULATE_LIST) {
  if (ids.length === 0) return [];
  const docs = await Bottle.find({ _id: { $in: ids } }).populate(populate).lean();
  const order = new Map(ids.map((id, i) => [String(id), i]));
  return docs.sort((a, b) => order.get(a._id.toString()) - order.get(b._id.toString()));
}

// The history page's sections: why a bottle left, as the page groups it —
// its consumedReason, else its status; anything unknown counts as other.
const HISTORY_REASONS = ['drank', 'gifted', 'sold', 'other'];
function reasonOf(b) {
  const reason = b.consumedReason || b.status;
  return HISTORY_REASONS.includes(reason) ? reason : 'other';
}
function countReasons(bottles) {
  const counts = { drank: 0, gifted: 0, sold: 0, other: 0 };
  for (const b of bottles) counts[reasonOf(b)] += 1;
  return counts;
}

// The history's order: newest consumedAt first, a bottle without one last,
// the newer _id first on a tie (a bulk "mark as drunk" or an import stamps
// many bottles with one date). The same order as MongoDB's
// .sort({ consumedAt: -1, _id: -1 }), so both can page one list.
function historyOrder(a, b) {
  const at = a.consumedAt ? new Date(a.consumedAt).getTime() : null;
  const bt = b.consumedAt ? new Date(b.consumedAt).getTime() : null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at;
  }
  const ai = String(a._id);
  const bi = String(b._id);
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

// ?before=<consumedAt ISO, or empty>|<bottle id>: the last bottle a section
// shows. Its next page starts after that bottle's place in the order, not
// after a count, so a bottle consumed or restored between two pages — or a
// page the app's cache kept from an earlier visit — can't make the next page
// repeat or skip bottles.
function parseHistoryCursor(value) {
  if (typeof value !== 'string') return null;
  const [at, id] = value.split('|');
  if (!id || !mongoose.isValidObjectId(id)) return null;
  const consumedAt = at ? new Date(at) : null;
  if (consumedAt && Number.isNaN(consumedAt.getTime())) return null;
  return { consumedAt, _id: id.toLowerCase() };
}

// One page of `list` (in the history's order): only one section's bottles
// when `reason` is set, starting after `cursor`, else after `skip` bottles.
function sliceHistory(list, { reason = null, cursor = null, skip = 0, limit }) {
  const section = reason ? list.filter(b => reasonOf(b) === reason) : list;
  let start = skip;
  if (cursor) {
    const at = section.findIndex(b => historyOrder(b, cursor) > 0);
    start = at < 0 ? section.length : at;
  }
  const page = section.slice(start, start + limit);
  return { page, remaining: Math.max(0, section.length - start - page.length) };
}

/**
 * One page of a history: every matching bottle's order and reason first (four
 * fields), then only the page in full. The total and per-reason counts cover
 * everything `match` selects; `remaining` counts what comes after the page.
 */
async function pageHistory(match, paging) {
  const light = await Bottle.find(match)
    .select('_id consumedAt consumedReason status')
    .sort({ consumedAt: -1, _id: -1 })
    .limit(10000)
    .lean();
  const { page, remaining } = sliceHistory(light, paging);
  const bottles = await loadBottlesInOrder(page.map(b => b._id));
  return { bottles, total: light.length, reasonCounts: countReasons(light), remaining };
}

// ?limit pages a history. The first page is the newest bottles of every
// section; a section's next page asks for ?reason=<section>&before=<its last
// bottle>. (?skip pages by count, as elsewhere.) Only the first page carries
// the filter modal's facets — the pages after it reuse them.
function historyPaging(query) {
  if (query.limit === undefined) return null;
  const { limit, offset: skip } = parsePagination(query, { limit: 50, maxLimit: 200 });
  const reason = HISTORY_REASONS.includes(query.reason) ? query.reason : null;
  const cursor = parseHistoryCursor(query.before);
  return { limit, skip, reason, cursor, continuing: !!(reason || cursor || skip > 0) };
}

module.exports = {
  loadBottlesInOrder,
  countReasons,
  historyOrder,
  sliceHistory,
  pageHistory,
  historyPaging,
};
