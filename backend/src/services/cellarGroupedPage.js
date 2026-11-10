// The grouped cellar page: identical bottles (same wine, vintage and size)
// shown as one card. loadGroupedBottlePage groups and pages inside MongoDB
// for the unfiltered page; the name and quantity orders are what the
// filtered and searched lists in routes/cellars.js sort their groups with
// (GET /api/cellars/:id and GET /api/cellars/multi/bottles).

const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { NOT_IN_CELLAR_STATUSES, WINE_POPULATE_LIST } = require('../config/constants');

// Group key parts default like the JS grouping path: missing/empty vintage →
// 'NV', missing/empty bottleSize → '750ml'. $ifNull alone misses empty strings.
function groupPartExpr(field, fallback) {
  return {
    $let: {
      vars: { v: { $ifNull: [`$${field}`, fallback] } },
      in: { $cond: [{ $eq: ['$$v', ''] }, fallback, '$$v'] },
    },
  };
}

// Sort by quantity: the grouped list's cards by how many identical bottles
// each holds — sortDir -1 most first; cards holding as many stay A to Z.
// Lists that are not grouped keep name order.
const QUANTITY_SORT = 'quantity';
// A bottle's wine name for sorting, case-insensitive: the registry wine's, a
// pending request's, or — with neither — after every named wine.
const wineSortName = (b) => (b.wineDefinition?.name || b.pendingWineRequest?.wineName || '\uffff').toLowerCase();
const byWineName = (a, b) => {
  const av = wineSortName(a);
  const bv = wineSortName(b);
  return av < bv ? -1 : av > bv ? 1 : 0;
};
// Stable: groups holding as many keep the order their bottles came in.
function sortGroupsByQuantity(groups, sortDir) {
  return groups.sort((a, b) => sortDir * (a.bottles.length - b.bottles.length));
}

/**
 * DB-side grouping for the default cellar page (?group=1, no filters).
 *
 * The JS grouping path must load and populate the ENTIRE cellar to render 30
 * groups — on every page view and every search keystroke. This groups bottles
 * by (wine, vintage, bottleSize) and paginates over groups inside MongoDB,
 * then populates only the returned page's members.
 *
 * Aggregation pipelines bypass Mongoose casting, so ids are cast explicitly.
 */
async function loadGroupedBottlePage({ cellarId, excludeSet, onlyIds = null, sortField, sortDir, skip, limit, populate = WINE_POPULATE_LIST }) {
  const { ObjectId } = mongoose.Types;
  const match = {
    cellar: new ObjectId(String(cellarId)),
    status: { $nin: NOT_IN_CELLAR_STATUSES },
  };
  if (excludeSet.size > 0) {
    match._id = { $nin: [...excludeSet].map(id => new ObjectId(id)) };
  }
  // The rack / group filter is an include set already minus excludeSet.
  if (onlyIds) match._id = { $in: [...onlyIds].map(id => new ObjectId(id)) };
  const groupId = {
    // Bottles without a wine stay singleton groups (keyed by their own _id)
    wine: { $ifNull: ['$wineDefinition', '$_id'] },
    vintage: groupPartExpr('vintage', 'NV'),
    size: groupPartExpr('bottleSize', '750ml'),
  };

  let pageGroups;
  let countResult;
  if (sortField === QUANTITY_SORT) {
    // Every group's size (ids only — nothing populated), the wines' names
    // once for the ties, then only the page's members are loaded below.
    const all = await Bottle.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $group: { _id: groupId, n: { $sum: 1 }, wineRef: { $first: '$wineDefinition' }, memberIds: { $push: '$_id' } } },
    ]).allowDiskUse(true);
    const wineIds = [...new Set(all.map((g) => g.wineRef).filter(Boolean).map(String))];
    const names = new Map((wineIds.length
      ? await WineDefinition.find({ _id: { $in: wineIds } }).select('name').lean()
      : []).map((w) => [String(w._id), (w.name || '').toLowerCase()]));
    const nameOf = (g) => (g.wineRef && names.get(String(g.wineRef))) || '\uffff';
    all.sort((a, b) => sortDir * (a.n - b.n)
      || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0)
      || (String(a._id.wine) < String(b._id.wine) ? -1 : String(a._id.wine) > String(b._id.wine) ? 1 : 0)
      || (String(a._id.vintage) < String(b._id.vintage) ? -1 : String(a._id.vintage) > String(b._id.vintage) ? 1 : 0)
      || (String(a._id.size) < String(b._id.size) ? -1 : String(a._id.size) > String(b._id.size) ? 1 : 0));
    pageGroups = all.slice(skip, skip + limit);
    countResult = [{ total: all.length, bottles: all.reduce((sum, g) => sum + g.n, 0) }];
  } else [pageGroups, countResult] = await Promise.all([
    Bottle.aggregate([
      { $match: match },
      { $sort: { [sortField]: sortDir } },
      // $first/$push follow the preceding $sort within each group, so the
      // group's sortVal is its best-ranked member and members stay sorted.
      // wineRef keeps the RAW reference (null when absent) so the group key
      // below can distinguish "no wine" from a real (possibly dangling) ref.
      {
        $group: {
          _id: groupId,
          sortVal: { $first: `$${sortField}` },
          wineRef: { $first: '$wineDefinition' },
          memberIds: { $push: '$_id' },
        },
      },
      // _id as tiebreaker: $skip/$limit pagination over groups re-runs this
      // pipeline per page, and tied sortVals (e.g. sort=rating where most
      // groups are unrated) have no stable order without it — pages would
      // show duplicate groups and silently skip others.
      { $sort: { sortVal: sortDir, _id: 1 } },
      { $skip: skip },
      { $limit: limit },
    ]).allowDiskUse(true),
    Bottle.aggregate([
      { $match: match },
      { $group: { _id: groupId, n: { $sum: 1 } } },
      { $group: { _id: null, total: { $sum: 1 }, bottles: { $sum: '$n' } } },
    ]).allowDiskUse(true),
  ]);

  const memberIds = pageGroups.flatMap(g => g.memberIds);
  const docs = await Bottle.find({ _id: { $in: memberIds } })
    .populate(populate)
    .lean();
  const byId = new Map(docs.map(d => [d._id.toString(), d]));

  const groupsForPage = pageGroups
    .map(g => {
      const members = g.memberIds.map(id => byId.get(id.toString())).filter(Boolean);
      // Key format matches the JS grouping path and is built from the GROUP
      // identity (not a populated member, which can be missing if a bottle
      // was deleted between the aggregation and the populate): vintage/size
      // in g._id already carry the NV/750ml defaults.
      const wineId = g.wineRef ? String(g.wineRef) : `none:${String(g.memberIds[0])}`;
      const key = `${wineId}::${g._id.vintage}::${g._id.size}`;
      return { key, bottles: members };
    })
    // A group can lose all members to the populate race above — emitting it
    // empty would hand the client a card with no bottle to render.
    .filter(g => g.bottles.length > 0);

  return {
    groupsForPage,
    bottles: groupsForPage.flatMap(g => g.bottles),
    totalCount: countResult[0]?.total || 0,
    bottleTotal: countResult[0]?.bottles || 0,
  };
}

module.exports = {
  QUANTITY_SORT,
  byWineName,
  sortGroupsByQuantity,
  loadGroupedBottlePage,
};
