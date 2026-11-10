// The cross-cellar query engine: bottles across several cellars at once.
//
// Powers the "search across several cellars at once" views. Given a set of
// already-access-checked cellar ids, it mirrors the single-cellar bottle/history
// routes' search/filter/sort/maturity semantics, MINUS grouping and rack
// exclusion (both single-cellar concepts). Returns a flat, paginated list; the
// caller tags each bottle with which cellar it lives in.
//
// Callers: GET /api/cellars/multi/bottles and GET /api/cellars/multi/history
// (routes/cellars.js), which resolve the cellars the user can read, run the
// query over the ones asked for and count the filter modal's facets.

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const bottleSearch = require('./bottleSearch');
const { coerceStringQuery } = require('../utils/validation');
const { parsePagination } = require('../utils/pagination');
const { filterByRating } = require('../utils/ratingUtils');
const {
  classifyMaturity, buildProfileMap, parseMaturityFilter, matchesMaturityFilter,
  buildMaturitySortKeys, compareMaturitySortKeys,
} = require('../utils/maturityUtils');
const { parseExtraBottleFilters, applyExtraBottleFilters } = require('../utils/bottleListFilters');
const { CONSUMED_STATUSES, NOT_IN_CELLAR_STATUSES, WINE_POPULATE_LIST } = require('../config/constants');
const { loadBottlesInOrder, countReasons, historyOrder, sliceHistory, pageHistory } = require('./cellarHistory');
const { QUANTITY_SORT, byWineName } = require('./cellarGroupedPage');

// Resolve every cellar the user can read (owned + shared), as lean docs.
async function resolveAccessibleCellars(userId) {
  return Cellar.find({
    $or: [{ user: userId }, { 'members.user': userId }],
    deletedAt: null,
  }).lean();
}

// `history` (historyPaging's answer) pages a history instead of `paginate`.
async function queryBottlesAcrossCellars(req, { cellarIds, statusFilter, paginate = true, history = null, version }) {
  // Coerce every query param to a string up front: Express turns repeated
  // (?sort=a&sort=b) or bracketed (?search[$gt]=x) params into arrays/objects,
  // which would blow up sort.startsWith / search.toLowerCase with a 500.
  const search = coerceStringQuery(req.query.search);
  const type = coerceStringQuery(req.query.type);
  const country = coerceStringQuery(req.query.country);
  const region = coerceStringQuery(req.query.region);
  const grapes = coerceStringQuery(req.query.grapes);
  const vintage = coerceStringQuery(req.query.vintage);
  const appellation = coerceStringQuery(req.query.appellation);
  const minRating = coerceStringQuery(req.query.minRating);
  const maxRating = coerceStringQuery(req.query.maxRating);
  const ratingBandParam = coerceStringQuery(req.query.ratingBand);
  // null when absent; a Set of statuses otherwise (multi-select, OR-combined).
  const maturityFilter = parseMaturityFilter(coerceStringQuery(req.query.maturity));
  const sort = coerceStringQuery(req.query.sort) || '-createdAt';
  const { limit, offset: skip } = parsePagination(req.query, { limit: 30, maxLimit: 200 });
  const { isValidObjectId } = mongoose;
  const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
  const sortDir = sort.startsWith('-') ? -1 : 1;
  const grapeIds = grapes
    ? String(grapes).split(',').map(g => g.trim()).filter(isValidObjectId)
    : [];
  const hasSearchFilters = !!(search || type || country || region || grapes || vintage || appellation);
  // ?producer / ?bottleSize / ?purchaseYear (chart deep links) — post-filters.
  const extraFilters = parseExtraBottleFilters(req.query);
  const needsMaturity = statusFilter !== 'consumed' && !!(maturityFilter || sortField === 'maturity');
  const statusMongo = statusFilter === 'consumed'
    ? { $in: CONSUMED_STATUSES }
    : { $nin: NOT_IN_CELLAR_STATUSES };
  const objectIds = cellarIds.map(id => new mongoose.Types.ObjectId(id));

  // ── HOT PATH: default view (no search/filters, DB-sortable) ──
  // Paginate inside MongoDB instead of hydrating up to 10k populated bottles to
  // slice a 30-item page. Mirrors the single-cellar route's canPaginateInDb;
  // trivially correct here since the cross-cellar view never groups.
  const canPaginateInDb = paginate
    && !hasSearchFilters
    && !minRating && !maxRating && !ratingBandParam && !maturityFilter && !extraFilters
    && ['createdAt', 'vintage', 'price', 'rating'].includes(sortField);
  if (canPaginateInDb) {
    const filter = { cellar: { $in: objectIds }, status: statusMongo };
    const [pageDocs, totalCount] = await Promise.all([
      Bottle.find(filter).populate(WINE_POPULATE_LIST).sort({ [sortField]: sortDir }).skip(skip).limit(limit).lean(),
      Bottle.countDocuments(filter),
    ]);
    return { items: pageDocs, total: totalCount, limit, skip, maturityStatusMap: null, found: null };
  }

  let bottles;
  let found = null;

  if (hasSearchFilters) {
    // ── SEARCH: text (typo-tolerant, ranked) + the wine filters, across the set ──
    found = await bottleSearch.searchBottles(search || '', {
      cellarIds,
      type,
      countryId: country,
      regionId: region,
      appellation,
      grapeIds,
      vintage,
      statusFilter,
      sort,
      limit: 10000,
      offset: 0,
      version,
    });
    // The search has ranked and sorted every hit. With nothing left to filter
    // or re-sort in memory, load only the page instead of every hit.
    const pageOnly = paginate && statusFilter !== 'consumed'
      && !minRating && !maxRating && !ratingBandParam && !maturityFilter && !extraFilters
      && sortField !== 'name' && sortField !== 'maturity' && sortField !== QUANTITY_SORT;
    if (pageOnly) {
      const items = await loadBottlesInOrder(found.ids.slice(skip, skip + limit));
      return { items, total: found.ids.length, limit, skip, maturityStatusMap: null, found };
    }
  }

  // ── HISTORY PAGE: as the single-cellar history pages — every match's order
  // and reason (four fields), then only the page in full. The rating and
  // chart filters (not offered on the history page) read whole bottles, so
  // they take the path below.
  if (history && !minRating && !maxRating && !ratingBandParam && !extraFilters) {
    const page = await pageHistory(found
      ? { _id: { $in: found.ids } }
      : { cellar: { $in: objectIds }, status: statusMongo }, history);
    return { items: page.bottles, total: page.total, reasonCounts: page.reasonCounts, remaining: page.remaining, found };
  }

  if (found) {
    bottles = await loadBottlesInOrder(found.ids);
  } else {
    // ── LIST: no search — rating / maturity / chart filters or an in-memory sort ──
    bottles = await Bottle.find({ cellar: { $in: objectIds }, status: statusMongo })
      .populate(WINE_POPULATE_LIST)
      // Cap on the field we ultimately order by, so a >10k set keeps the right
      // slice: newest-consumed for history, newest-added for active bottles.
      .sort(statusFilter === 'consumed' ? { consumedAt: -1 } : { createdAt: -1 })
      .limit(10000)
      .lean();
  }

  // ── Shared post-filters (extra + rating + maturity), applied to both paths ──
  bottles = applyExtraBottleFilters(bottles, extraFilters);
  // A drunk bottle counts with the rating given when drinking (the history
  // list), and a band is exactly the statistics' band (utils/ratingUtils).
  bottles = filterByRating(bottles, { minRating, maxRating, ratingBand: ratingBandParam });
  let maturityStatusMap;
  let maturitySortKeys;
  if (needsMaturity) {
    const profileMap = await buildProfileMap(bottles);
    maturityStatusMap = new Map();
    for (const b of bottles) maturityStatusMap.set(b._id.toString(), classifyMaturity(b, profileMap));
    if (sortField === 'maturity') maturitySortKeys = buildMaturitySortKeys(bottles, profileMap, maturityStatusMap);
  }
  if (maturityFilter && maturityStatusMap) {
    bottles = bottles.filter(b => matchesMaturityFilter(maturityStatusMap.get(b._id.toString()), maturityFilter));
  }

  // ── Sort ──
  if (statusFilter === 'consumed') {
    // History is a chronological view — newest-consumed first, always.
    bottles.sort(historyOrder);
  } else if (sortField === 'name') {
    bottles.sort((a, b) => sortDir * byWineName(a, b));
  } else if (sortField === QUANTITY_SORT) {
    bottles.sort(byWineName);
  } else if (sortField === 'maturity' && maturitySortKeys) {
    bottles.sort((a, b) => sortDir * compareMaturitySortKeys(
      maturitySortKeys.get(a._id.toString()), maturitySortKeys.get(b._id.toString())));
  } else if (!found) {
    // The search ranked its hits (relevance, then the sort); a list sorts here.
    bottles.sort((a, b) => {
      const av = a[sortField] ?? 0;
      const bv = b[sortField] ?? 0;
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });
  }

  const total = bottles.length;
  // History pages show counts per reason for the whole (filtered) history.
  const reasonCounts = statusFilter === 'consumed' ? countReasons(bottles) : undefined;
  let items = paginate ? bottles.slice(skip, skip + limit) : bottles;
  let remaining;
  if (history) ({ page: items, remaining } = sliceHistory(bottles, history));
  // `found` carries the search's facet counts, so the caller needs no second pass.
  return { items, total, limit, skip, maturityStatusMap, found, reasonCounts, remaining, sortField, sortDir };
}

// Facets + facetMeta across the cellar set, for the shared filter modal.
// A search already counted them (`found` from queryBottlesAcrossCellars);
// otherwise one grouping query over the set does.
async function facetsAcrossCellars({ cellarIds, statusFilter, found }) {
  const source = found || await bottleSearch.bottleFacets({ cellarIds, statusFilter });
  return {
    facets: source.facetDistribution,
    baseFacets: source.baseFacetDistribution,
    facetMeta: source.facetMeta,
  };
}

module.exports = {
  resolveAccessibleCellars,
  queryBottlesAcrossCellars,
  facetsAcrossCellars,
};
