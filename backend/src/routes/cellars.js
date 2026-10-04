const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const Rack = require('../models/Rack');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const BottleImage = require('../models/BottleImage');
const PendingShare = require('../models/PendingShare');
const ClimateDevice = require('../models/ClimateDevice');
const WineRequest = require('../models/WineRequest');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { createCellar } = require('../services/rackOps');
const { getSnapshotsForDates, getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');
const { createNotification } = require('../services/notifications');
const { transferCellarOwnership } = require('../services/cellarTransfer');
const { sendCellarInviteEmail } = require('../services/mailgun');
const { toNormalized } = require('../utils/ratingUtils');
const { classifyMaturity, buildProfileMap, parseMaturityFilter, matchesMaturityFilter } = require('../utils/maturityUtils');
const { isReserved } = require('../utils/reservationUtils');
const {
  normalizeTaxonomyQuery, parseExtraBottleFilters, applyExtraBottleFilters, groupIdenticalBottles,
} = require('../utils/bottleListFilters');
const { CONSUMED_STATUSES, NOT_IN_CELLAR_STATUSES, ORDERED_STATUS, WINE_POPULATE_LIST, WINE_POPULATE_CARDS } = require('../config/constants');
const mongoose = require('mongoose');
const { parsePagination } = require('../utils/pagination');
const bottleSearch = require('../services/bottleSearch');
const { getDataVersion } = require('../services/dataVersion');

// The data version of a search scope's owners (services/dataVersion): the
// search keeps the scope's documents while it holds (services/bottleSearch),
// so typing and paging through one search load the cellar once.
const scopeVersion = (ownerIds) => [...new Set(ownerIds.map((id) => String(id && id._id ? id._id : id)))]
  .sort()
  .map((id) => `${id}:${getDataVersion(id)}`)
  .join(',');
const { isValidId, coerceStringQuery } = require('../utils/validation');

const router = express.Router();

// Resolve the requesting user's personal color preference for a cellar
function getUserColor(cellar, userId) {
  const entry = cellar.userColors?.find(uc => uc.user.toString() === userId.toString());
  return entry?.color || null;
}

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

  const [pageGroups, countResult] = await Promise.all([
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
      { $group: { _id: groupId } },
      { $count: 'total' },
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
  };
}

// ── Cross-cellar (multi-select) query engine ──────────────────────────────
// Powers the "search across several cellars at once" views. Given a set of
// already-access-checked cellar ids, it mirrors the single-cellar bottle/history
// routes' search/filter/sort/maturity semantics, MINUS grouping and rack
// exclusion (both single-cellar concepts). Returns a flat, paginated list; the
// caller tags each bottle with which cellar it lives in.

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

// Resolve every cellar the user can read (owned + shared), as lean docs.
async function resolveAccessibleCellars(userId) {
  return Cellar.find({
    $or: [{ user: userId }, { 'members.user': userId }],
    deletedAt: null,
  }).lean();
}

const MATURITY_RANK_MULTI = { declining: 0, late: 1, peak: 2, early: 3, 'not-ready': 4 };

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
    && !minRating && !maxRating && !maturityFilter && !extraFilters
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
      && !minRating && !maxRating && !maturityFilter && !extraFilters
      && sortField !== 'name' && sortField !== 'maturity';
    if (pageOnly) {
      const items = await loadBottlesInOrder(found.ids.slice(skip, skip + limit));
      return { items, total: found.ids.length, limit, skip, maturityStatusMap: null, found };
    }
  }

  // ── HISTORY PAGE: as the single-cellar history pages — every match's order
  // and reason (four fields), then only the page in full. The rating and
  // chart filters (not offered on the history page) read whole bottles, so
  // they take the path below.
  if (history && !minRating && !maxRating && !extraFilters) {
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
  if (minRating) {
    const min = parseFloat(minRating);
    bottles = bottles.filter(b => b.rating && toNormalized(b.rating, b.ratingScale || '5') >= min);
  }
  if (maxRating) {
    const max = parseFloat(maxRating);
    bottles = bottles.filter(b => b.rating && toNormalized(b.rating, b.ratingScale || '5') <= max);
  }
  let maturityStatusMap;
  if (needsMaturity) {
    const profileMap = await buildProfileMap(bottles);
    maturityStatusMap = new Map();
    for (const b of bottles) maturityStatusMap.set(b._id.toString(), classifyMaturity(b, profileMap));
  }
  if (maturityFilter && maturityStatusMap) {
    bottles = bottles.filter(b => matchesMaturityFilter(maturityStatusMap.get(b._id.toString()), maturityFilter));
  }

  // ── Sort ──
  if (statusFilter === 'consumed') {
    // History is a chronological view — newest-consumed first, always.
    bottles.sort(historyOrder);
  } else if (sortField === 'name') {
    bottles.sort((a, b) => {
      const av = (a.wineDefinition?.name || '').toLowerCase();
      const bv = (b.wineDefinition?.name || '').toLowerCase();
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });
  } else if (sortField === 'maturity' && maturityStatusMap) {
    bottles.sort((a, b) => {
      const av = maturityStatusMap.get(a._id.toString());
      const bv = maturityStatusMap.get(b._id.toString());
      return ((av != null ? MATURITY_RANK_MULTI[av] : 5) - (bv != null ? MATURITY_RANK_MULTI[bv] : 5)) * sortDir;
    });
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
  return { items, total, limit, skip, maturityStatusMap, found, reasonCounts, remaining };
}

// Attach the same per-bottle image fields the single-cellar /:id route adds, so
// the cross-cellar bottle list honours user-chosen default images and the
// uploader's own not-yet-approved photos (BottleCard reads defaultImageUrl /
// pendingImageUrl). Returns a new array; input bottles are lean.
async function attachBottleImageUrls(bottles, userId) {
  if (!bottles.length) return bottles;
  const bottleIds = bottles.map(b => b._id);

  // Matched by bottle OR by wine, mirroring the single-bottle route. A photo
  // taken while adding five bottles of the same wine is linked to exactly one
  // of them, so matching on bottle alone left the other four blank in every
  // list — while the bottle page, which already matches on wineDefinition,
  // showed the photo on all five. Same bottle, two answers depending on which
  // page you opened.
  const wineIdOf = (b) => b.wineDefinition && (b.wineDefinition._id || b.wineDefinition);
  const wineIds = [...new Set(bottles.map(wineIdOf).filter(Boolean).map(String))];

  // Sibling bottles: the viewer's OTHER bottles of the same wines, whether or
  // not they are on this page. A photo uploaded while the bottle still waited
  // for its wine request carries no wineDefinition at all (support ticket
  // 2026-09-07: one of two identical bottles showed the photo, the other did
  // not), so the by-wine arm never sees it — the photo's bottle is the only
  // way to learn its wine.
  const wineOfBottle = {};
  for (const b of bottles) { const w = wineIdOf(b); if (w) wineOfBottle[b._id.toString()] = w.toString(); }
  if (wineIds.length) {
    try {
      const siblings = await Bottle.find({ user: userId, wineDefinition: { $in: wineIds } }).select('_id wineDefinition').lean();
      for (const s of siblings) if (s.wineDefinition) wineOfBottle[s._id.toString()] = s.wineDefinition.toString();
    } catch (err) {
      // A photo nicety must never take the cellar list down.
      console.error('Sibling photo lookup failed:', err.message);
    }
  }
  const imageBottleIds = Object.keys(wineOfBottle).length ? Object.keys(wineOfBottle) : bottleIds.map(String);
  for (const id of bottleIds.map(String)) if (!imageBottleIds.includes(id)) imageBottleIds.push(id);

  const pendingImages = await BottleImage.find({
    $or: [
      { bottle: { $in: imageBottleIds } },
      ...(wineIds.length ? [{ wineDefinition: { $in: wineIds } }] : []),
    ],
    uploadedBy: userId,
    // The uploader's OWN photos, pending OR approved. Approval used to drop a
    // photo out of this lookup, so the moment an admin approved it the card
    // went blank unless the wine had a registry image — while the bottle page
    // gallery still listed it (support ticket 2026-09-05, discussion #1227;
    // 471 bottles of 49 owners on 2026-09-06). Rejected stays out.
    status: { $in: ['uploaded', 'processing', 'processed', 'approved'] },
    // Never a label scan (support ticket 2026-09-03). The raw frame handed to
    // the AI scanner is kept ONLY as private curation evidence (models/
    // BottleImage.kind); it carries the wine it minted, sits at status
    // 'uploaded' with no processed file, and so matched the by-wine arm above —
    // the scanner's kitchen-table photo became the card image of every bottle
    // of that wine. `$ne`, not `kind: 'bottle'`: rows older than the field
    // have no `kind` at all.
    kind: { $ne: 'label-scan' },
  }).sort({ createdAt: -1 }).lean();

  // Two maps, consulted bottle-first: a photo pinned to this exact bottle must
  // always beat one that merely matches the wine, or choosing a per-bottle
  // photo would appear to do nothing.
  const pendingByBottle = {};
  const pendingByWine = {};
  for (const img of pendingImages) {
    const url = img.processedUrl || img.originalUrl;
    if (!url) continue;
    if (img.bottle && !pendingByBottle[img.bottle.toString()]) {
      pendingByBottle[img.bottle.toString()] = url;
    }
    // The wine the photo belongs to: its own reference, else its bottle's.
    const imgWine = (img.wineDefinition && img.wineDefinition.toString()) || (img.bottle && wineOfBottle[img.bottle.toString()]) || null;
    if (imgWine && !pendingByWine[imgWine]) {
      pendingByWine[imgWine] = url;
    }
  }

  const defaultImageIds = bottles.filter(b => b.defaultImage).map(b => b.defaultImage);
  const defaultImages = defaultImageIds.length > 0
    ? await BottleImage.find({ _id: { $in: defaultImageIds } }).lean()
    : [];
  const defaultImageMap = {};
  for (const img of defaultImages) {
    defaultImageMap[img._id.toString()] = img.processedUrl || img.originalUrl;
  }

  return bottles.map(b => {
    const wineId = wineIdOf(b);
    return {
      ...b,
      pendingImageUrl:
        pendingByBottle[b._id.toString()]
        || (wineId ? pendingByWine[wineId.toString()] : null)
        || null,
      defaultImageUrl: b.defaultImage ? (defaultImageMap[b.defaultImage.toString()] || null) : null,
    };
  });
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

// All routes require authentication
router.use(requireAuth);

// GET /api/cellars - List user's cellars (owned + shared)
router.get('/', async (req, res) => {
  try {
    const cellars = await Cellar.find({
      $or: [{ user: req.user.id }, { 'members.user': req.user.id }],
      deletedAt: null
    }).sort({ createdAt: -1 });

    // Inject the requesting user's role + personal color into each cellar object
    const cellarsWithRole = cellars.map(c => {
      const obj = c.toObject();
      obj.userRole = getCellarRole(c, req.user.id);
      obj.userColor = getUserColor(c, req.user.id);
      return obj;
    });

    res.json({ count: cellarsWithRole.length, cellars: cellarsWithRole });
  } catch (error) {
    console.error('Get cellars error:', error);
    res.status(500).json({ error: 'Failed to get cellars' });
  }
});

// POST /api/cellars - Create cellar
router.post('/', async (req, res) => {
  try {
    const { name, description, color } = req.body;
    // Core create (name/description + audit) is shared with the MCP tool;
    // colour is a UI-only preference the tool doesn't set, applied here after.
    const result = await createCellar({ name, description }, req);
    if (result.error) {
      // Preserve the REST route's historical 400 on duplicate name.
      const status = result.error.code === 'duplicate' ? 400 : result.error.status;
      return res.status(status).json({ error: result.error.message });
    }
    const cellar = result.cellar;
    if (color) {
      cellar.userColors = [{ user: req.user.id, color }];
      await cellar.save();
    }
    const obj = cellar.toObject();
    obj.userRole = 'owner';
    obj.userColor = getUserColor(cellar, req.user.id);
    res.status(201).json({ cellar: obj });
  } catch (error) {
    console.error('Create cellar error:', error);
    res.status(500).json({ error: 'Failed to create cellar' });
  }
});

// ── Cross-cellar (multi-select) views ──────────────────────────────────────
// NOTE: these MUST be declared before the "/:id*" routes below, otherwise
// Express would treat "multi" as an :id. Access is enforced server-side: only
// cellars the user owns or is a member of are ever searched, so an unknown or
// unauthorized id in ?cellars is silently dropped (never leaks another user's
// bottles).

// GET /api/cellars/multi/bottles?cellars=id1,id2,...&search=&type=&...
// Active bottles across the selected cellars (flat list, no grouping/racks).
router.get('/multi/bottles', async (req, res) => {
  try {
    const requested = String(req.query.cellars || '')
      .split(',').map(s => s.trim()).filter(isValidId);
    if (requested.length === 0) return res.status(400).json({ error: 'No cellars selected' });

    const accessible = await resolveAccessibleCellars(req.user.id);
    const accessibleMap = new Map(accessible.map(c => [c._id.toString(), c]));
    const cellarIds = [...new Set(requested)].filter(id => accessibleMap.has(id));
    if (cellarIds.length === 0) return res.status(403).json({ error: 'No accessible cellars selected' });

    await normalizeTaxonomyQuery(req.query);
    // ?group=1 collapses identical bottles (same cellar + wine + vintage +
    // size) like the single-cellar view — needed now that chart deep links
    // land here (support ticket 2026-09-19: "multiple identical bottles are
    // listed sequentially"). Paginates over groups, so it takes the whole
    // filtered set (the query's own 10k cap still bounds it).
    const grouped = req.query.group === '1' || req.query.group === 'true';
    const result = await queryBottlesAcrossCellars(req, {
      cellarIds, statusFilter: 'active', paginate: !grouped,
      version: scopeVersion(cellarIds.map(id => accessibleMap.get(id).user)),
    });
    const { limit, skip, maturityStatusMap, found } = result;
    let { total } = result;
    let items = result.items;
    let groupsForPage = null;
    if (grouped) {
      const allGroups = groupIdenticalBottles(items, { byCellar: true });
      total = allGroups.length;
      groupsForPage = allGroups.slice(skip, skip + limit);
      items = groupsForPage.flatMap(g => g.bottles);
    }
    // Facets only change the filter modal, which the client reads on the first
    // page only — skip counting them on every Load More.
    const { facets, baseFacets, facetMeta } = skip === 0
      ? await facetsAcrossCellars({ cellarIds, statusFilter: 'active', found })
      : { facets: null, baseFacets: null, facetMeta: null };

    // Match the single-cellar route's per-bottle enrichment (default/pending
    // images), then tag each bottle with the cellar it lives in + maturity.
    items = await attachBottleImageUrls(items, req.user.id);
    for (const b of items) {
      if (maturityStatusMap) b.maturityStatus = maturityStatusMap.get(b._id.toString()) || null;
      const c = accessibleMap.get(String(b.cellar));
      b.cellarName = c?.name || null;
      b.cellarColor = c ? getUserColor(c, req.user.id) : null;
    }
    // Re-nest the enriched bottles into their groups: same { key, count,
    // bottles } entries as the single-cellar ?group=1 response.
    if (groupsForPage) {
      const itemById = new Map(items.map(it => [it._id.toString(), it]));
      items = groupsForPage.map(g => {
        const members = g.bottles.map(b => itemById.get(b._id.toString())).filter(Boolean);
        return { key: g.key, count: members.length, bottles: members };
      });
    }

    res.json({
      cellars: cellarIds.map(id => {
        const c = accessibleMap.get(id);
        return { _id: id, name: c.name, userColor: getUserColor(c, req.user.id) };
      }),
      bottles: { count: items.length, total, limit, skip, grouped, items },
      facets, baseFacets, facetMeta,
    });
  } catch (error) {
    console.error('Multi-cellar bottles error:', error);
    res.status(500).json({ error: 'Failed to load bottles' });
  }
});

// GET /api/cellars/multi/history?cellars=id1,id2,...&search=&type=&...
// Consumed/gifted/sold bottles across the selected cellars (newest first).
router.get('/multi/history', async (req, res) => {
  try {
    const requested = String(req.query.cellars || '')
      .split(',').map(s => s.trim()).filter(isValidId);
    if (requested.length === 0) return res.status(400).json({ error: 'No cellars selected' });

    const accessible = await resolveAccessibleCellars(req.user.id);
    const accessibleMap = new Map(accessible.map(c => [c._id.toString(), c]));
    const cellarIds = [...new Set(requested)].filter(id => accessibleMap.has(id));
    if (cellarIds.length === 0) return res.status(403).json({ error: 'No accessible cellars selected' });

    // ?limit pages it, as the single-cellar history does; without it, all.
    const history = historyPaging(req.query);
    const { items, found, total, reasonCounts, remaining } = await queryBottlesAcrossCellars(req, {
      cellarIds, statusFilter: 'consumed', paginate: false, history,
      version: scopeVersion(cellarIds.map(id => accessibleMap.get(id).user)),
    });
    const { facets, baseFacets, facetMeta } = history && history.continuing
      ? {}
      : await facetsAcrossCellars({ cellarIds, statusFilter: 'consumed', found });

    for (const b of items) {
      const c = accessibleMap.get(String(b.cellar));
      b.cellarName = c?.name || null;
      b.cellarColor = c ? getUserColor(c, req.user.id) : null;
    }

    res.json({
      cellars: cellarIds.map(id => {
        const c = accessibleMap.get(id);
        return { _id: id, name: c.name, userColor: getUserColor(c, req.user.id) };
      }),
      bottles: items,
      total,
      reasonCounts,
      remaining,
      facets, baseFacets, facetMeta,
    });
  } catch (error) {
    console.error('Multi-cellar history error:', error);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// GET /api/cellars/:id/statistics - Get cellar statistics (active bottles only)
router.get('/:id/statistics', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findById(req.params.id);
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    // Only active bottles count. One grouping query instead of loading every
    // bottle (the cellar page asks on every visit; a 2,800-bottle cellar took
    // ~100–140 ms): bottles that share wine, vintage, rating and scale, price
    // currency and price day count the same way in every figure below, so
    // each group is weighed by its size. A group's price sum converts like
    // its bottles one by one — the conversion is linear and prices are never
    // negative — up to how the sums round: MongoDB adds more precisely than
    // JavaScript, so a total or average that falls on half a cent can round
    // one cent the other way. Groups come in the order of their first bottle,
    // so the maps list their keys in a stable order.
    const priced = { $ne: [{ $ifNull: ['$price', 0] }, 0] };
    const groups = await Bottle.aggregate([
      { $match: { cellar: cellar._id, status: { $nin: NOT_IN_CELLAR_STATUSES } } },
      {
        $group: {
          _id: {
            wine: '$wineDefinition',
            vintage: '$vintage',
            rating: '$rating',
            ratingScale: '$ratingScale',
            currency: '$currency',
            // UTC day, as toISOString() gave it; null without a date.
            priceDay: { $dateToString: { format: '%Y-%m-%d', date: '$priceSetAt' } },
          },
          count: { $sum: 1 },
          priceCount: { $sum: { $cond: [priced, 1, 0] } },
          priceSum: { $sum: { $cond: [priced, '$price', 0] } },
          first: { $min: '$_id' },
        },
      },
      { $sort: { first: 1 } },
    ]).allowDiskUse(true);

    // The wines' type and country name, once per wine. A reference to a wine
    // that no longer exists resolves to nothing, as a populate did.
    const wineIds = [...new Set(groups.map(g => g._id.wine).filter(Boolean).map(String))];
    const wineById = new Map((wineIds.length
      ? await WineDefinition.find({ _id: { $in: wineIds } })
        .select('type country')
        .populate('country', 'name')
        .lean()
      : []).map(w => [String(w._id), w]));

    // Batch-load historical rate snapshots for all priceSetAt dates (one DB query)
    const targetCurrency = req.query.currency || null;
    let snapshotMap = new Map();
    let todaySnapshot = null;
    if (targetCurrency) {
      const priceDates = [...new Set(
        groups.filter(g => g.priceCount > 0 && g._id.priceDay).map(g => g._id.priceDay)
      )];
      if (priceDates.length > 0) {
        snapshotMap = await getSnapshotsForDates(priceDates);
      }
      // Fetch today's snapshot as fallback for bottles without priceSetAt
      todaySnapshot = await getOrCreateDailySnapshot();
    }

    // Calculate statistics
    const stats = {
      totalBottles: groups.reduce((n, g) => n + g.count, 0),
      // Bottles awaiting a wine request have no wineDefinition — exclude them
      // rather than letting `undefined` count as one extra "unique wine".
      uniqueWines: new Set(
        groups.filter(g => g._id.wine && wineById.has(String(g._id.wine))).map(g => String(g._id.wine))
      ).size,
      totalValue: 0,
      averagePrice: 0,
      convertedTotal: 0,
      convertedAverage: 0,
      convertedCurrency: targetCurrency,
      byCountry: {},
      byType: {},
      byVintage: {},
      byRating: {},
      oldestVintage: null,
      newestVintage: null
    };

    let priceCount = 0;
    let priceSum = 0;
    let convertedSum = 0;
    let convertedCount = 0;
    let oldestYear = Infinity;
    let newestYear = -Infinity;

    for (const g of groups) {
      const wine = g._id.wine ? wineById.get(String(g._id.wine)) : null;

      // Total value calculation
      if (g.priceCount > 0) {
        const currency = g._id.currency || 'USD';
        stats.totalValue += g.priceSum;
        priceSum += g.priceSum;
        priceCount += g.priceCount;

        // Currency-converted total: bottles already in the target currency are
        // used as-is; others are converted using the historical rate from the
        // day the price was entered, falling back to today's rates.
        if (targetCurrency) {
          if (currency === targetCurrency) {
            convertedSum += g.priceSum;
            convertedCount += g.priceCount;
          } else {
            const dateKey = g._id.priceDay || null;
            const rates = (dateKey && snapshotMap.get(dateKey))
              || (todaySnapshot ? todaySnapshot.rates : null);
            const converted = convertCurrency(g.priceSum, currency, targetCurrency, rates);
            if (converted !== null) {
              convertedSum += converted;
              convertedCount += g.priceCount;
            }
          }
        }
      }

      // By country
      const countryName = wine?.country?.name || 'Unknown';
      stats.byCountry[countryName] = (stats.byCountry[countryName] || 0) + g.count;

      // By type
      const type = wine?.type || 'Unknown';
      stats.byType[type] = (stats.byType[type] || 0) + g.count;

      // By vintage
      const vintage = g._id.vintage || 'NV';
      stats.byVintage[vintage] = (stats.byVintage[vintage] || 0) + g.count;

      // Track oldest/newest vintage
      if (vintage !== 'NV') {
        const year = parseInt(vintage);
        if (!isNaN(year)) {
          if (year < oldestYear) oldestYear = year;
          if (year > newestYear) newestYear = year;
        }
      }

      // By rating — normalize to 0-100 and bucket into 5 bands
      if (g._id.rating) {
        const norm = toNormalized(g._id.rating, g._id.ratingScale || '5');
        const band = norm <= 20 ? '0-20' : norm <= 40 ? '21-40' : norm <= 60 ? '41-60' : norm <= 80 ? '61-80' : '81-100';
        stats.byRating[band] = (stats.byRating[band] || 0) + g.count;
      }
    }

    stats.averagePrice = priceCount > 0 ? priceSum / priceCount : 0;
    stats.convertedTotal = convertedSum;
    stats.convertedAverage = convertedCount > 0 ? convertedSum / convertedCount : 0;
    stats.oldestVintage = oldestYear !== Infinity ? oldestYear : null;
    stats.newestVintage = newestYear !== -Infinity ? newestYear : null;

    // Round values
    stats.totalValue = Math.round(stats.totalValue * 100) / 100;
    stats.averagePrice = Math.round(stats.averagePrice * 100) / 100;
    stats.convertedTotal = Math.round(stats.convertedTotal * 100) / 100;
    stats.convertedAverage = Math.round(stats.convertedAverage * 100) / 100;

    res.json({ statistics: stats });
  } catch (error) {
    console.error('Get cellar statistics error:', error);
    res.status(500).json({ error: 'Failed to get cellar statistics' });
  }
});

// GET /api/cellars/:id/history - Get consumed/gifted/sold bottles for this cellar
router.get('/:id/history', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findById(req.params.id).populate('user', 'username');
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) return res.status(404).json({ error: 'Cellar not found' });

    const { search, type, country, region, grapes, vintage, appellation } = req.query;
    const grapeIds = grapes
      ? String(grapes).split(',').map(g => g.trim()).filter(mongoose.isValidObjectId)
      : [];
    const hasSearchFilters = !!(search || type || country || region || grapes || vintage || appellation);

    // ?limit pages the history (see historyPaging), with the total and the
    // per-reason counts the page's summary shows. A history imported from
    // another app can hold thousands of bottles, all sent and rendered at once
    // before. Without ?limit, the whole history (up to 10k) as before, for
    // callers that expect it.
    const paging = historyPaging(req.query);

    let bottles;
    let found = null;
    let total;
    let reasonCounts;
    let remaining;
    if (hasSearchFilters) {
      // Text search (typo-tolerant) + the wine filters — services/bottleSearch.
      found = await bottleSearch.searchBottles(search || '', {
        cellarId: req.params.id,
        statusFilter: 'consumed',
        type,
        countryId: country,
        regionId: region,
        appellation,
        grapeIds,
        vintage,
        limit: 10000,
        offset: 0,
        version: scopeVersion([cellar.user]),
      });
    }
    if (paging) {
      ({ bottles, total, reasonCounts, remaining } = await pageHistory(found
        ? { _id: { $in: found.ids } }
        : { cellar: req.params.id, status: { $in: CONSUMED_STATUSES } }, paging));
    } else if (found) {
      bottles = await loadBottlesInOrder(found.ids);
      // History is a chronological view — newest-consumed first, not relevance.
      bottles.sort((a, b) => new Date(b.consumedAt || 0) - new Date(a.consumedAt || 0));
    } else {
      // Capped at 10k so a cellar with a huge consumed history can't load the
      // entire collection into memory on every request.
      bottles = await Bottle.find({ cellar: req.params.id, status: { $in: CONSUMED_STATUSES } })
        .populate(WINE_POPULATE_LIST)
        .sort({ consumedAt: -1 })
        .limit(10000)
        .lean();
    }
    if (!paging) {
      total = bottles.length;
      reasonCounts = countReasons(bottles);
    }

    // Facets for the filter modal: the search counted them already; a plain
    // history page counts them in one grouping query. A section's next page
    // needs none — the page keeps the first page's.
    const facetSource = paging && paging.continuing
      ? null
      : found || await bottleSearch.bottleFacets({ cellarId: req.params.id, statusFilter: 'consumed' });

    const cellarObj = cellar.toObject();
    cellarObj.userRole = role;
    cellarObj.userColor = getUserColor(cellar, req.user.id);
    res.json({
      cellar: cellarObj,
      bottles,
      total,
      reasonCounts,
      remaining,
      facets: facetSource?.facetDistribution,
      baseFacets: facetSource?.baseFacetDistribution,
      facetMeta: facetSource?.facetMeta,
    });
  } catch (error) {
    console.error('Get cellar history error:', error);
    res.status(500).json({ error: 'Failed to get cellar history' });
  }
});

// GET /api/cellars/:id/on-order — the bottles bought for this cellar that
// have not arrived yet (status 'ordered'): soonest expected first, undated
// orders last. Any member may look; arriving / editing needs editor, which
// those endpoints enforce. Capped like the other list paths.
const ON_ORDER_LIMIT = 2000;
router.get('/:id/on-order', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findById(req.params.id).populate('user', 'username').lean();
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) return res.status(404).json({ error: 'Cellar not found' });

    const docs = await Bottle.find({ cellar: req.params.id, status: ORDERED_STATUS })
      .populate(WINE_POPULATE_CARDS)
      .sort({ expectedArrival: 1, createdAt: 1 })
      .limit(ON_ORDER_LIMIT)
      .lean();
    // An ascending sort puts a missing date FIRST; dated orders lead instead.
    const ordered = [...docs.filter((b) => b.expectedArrival), ...docs.filter((b) => !b.expectedArrival)];
    const bottles = await attachBottleImageUrls(ordered, req.user.id);

    res.json({
      cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
      bottles,
      total: bottles.length,
    });
  } catch (error) {
    console.error('Get on-order bottles error:', error);
    res.status(500).json({ error: 'Failed to get the bottles on order' });
  }
});

// GET /api/cellars/:id/members - List members (owner only)
router.get('/:id/members', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id, deletedAt: null })
      .populate('members.user', 'username email');
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    res.json({ members: cellar.members });
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

// GET /api/cellars/:id - Get cellar details with bottles (active only, with filtering)
router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    // Populate owner username so shared users can display "Shared by X"
    const cellar = await Cellar.findById(req.params.id).populate('user', 'username').lean();
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    // Chart deep links pass country/region/grape NAMES; every path below
    // (search, list, facets) filters by id.
    await normalizeTaxonomyQuery(req.query);
    // ?producer / ?bottleSize / ?purchaseYear — in-memory post-filters.
    const extraFilters = parseExtraBottleFilters(req.query);

    const {
      country,
      region,
      grapes,
      type,
      vintage,
      appellation,
      minRating,
      maxRating,
      search,
      maturity: maturityRaw,
      sort = '-createdAt',
      exclude
    } = req.query;
    // null when absent; a Set of statuses otherwise (multi-select, OR-combined
    // — support ticket 2026-09-12). Coerced first: qs can hand us an array.
    const maturityFilter = parseMaturityFilter(coerceStringQuery(maturityRaw));

    // Pagination — default 30, max 200; skip defaults to 0
    const { limit, offset: skip } = parsePagination(req.query, { limit: 30, maxLimit: 200 });

    // ?reserved=1 — only bottles that are "spoken for" (reservedFor and/or
    // reservedUntil set). Applied in memory on both paths, like minRating.
    const reservedOnly = req.query.reserved === '1' || req.query.reserved === 'true';

    // Optional grouping: collapse identical bottles (same wine + same vintage)
    // into one entry. Paginates over GROUPS and nests the member bottles so the
    // client can expand ("split") a group without another request. Opt-in via
    // ?group=1 so existing callers (add-bottle exclude flow, etc.) are unaffected.
    const grouped = req.query.group === '1' || req.query.group === 'true';

    const { isValidObjectId } = mongoose;
    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
    const sortDir = sort.startsWith('-') ? -1 : 1;

    // Parse grape IDs once (used by both paths)
    const grapeIds = grapes
      ? String(grapes).split(',').map(g => g.trim()).filter(isValidObjectId)
      : [];

    // Build the exclusion set once for both paths. ?excludePlaced=1 resolves
    // rack-placed bottles server-side — the slot pickers previously sent every
    // placed bottle ID in the query string, which overflows the URL length
    // limit once a few hundred bottles are placed.
    const excludeSet = new Set(exclude ? String(exclude).split(',').filter(isValidObjectId) : []);
    if (req.query.excludePlaced === '1' || req.query.excludePlaced === 'true') {
      const racks = await Rack.find({ cellar: req.params.id, deletedAt: null })
        .select('slots.bottle')
        .lean();
      for (const rack of racks) {
        for (const slot of rack.slots || []) {
          if (slot.bottle) excludeSet.add(slot.bottle.toString());
        }
      }
    }

    // ?rack=<id> or ?rackGroup=<name> — only the bottles placed in that rack,
    // or in any rack of that group ("what is in the basement", support ticket
    // 2026-09-06). Resolved to an id set once and applied on every path like
    // excludeSet; an unknown rack or group matches nothing.
    let onlyIds = null;
    if (req.query.rack || req.query.rackGroup) {
      onlyIds = new Set();
      const rackQuery = { cellar: req.params.id, deletedAt: null };
      let resolvable = true;
      if (req.query.rack) {
        if (isValidObjectId(String(req.query.rack))) rackQuery._id = String(req.query.rack);
        else resolvable = false;
      } else {
        rackQuery.group = String(req.query.rackGroup).trim().slice(0, 40);
      }
      if (resolvable) {
        const racks = await Rack.find(rackQuery).select('slots.bottle').lean();
        for (const rack of racks) {
          for (const slot of rack.slots || []) {
            if (slot.bottle && !excludeSet.has(slot.bottle.toString())) onlyIds.add(slot.bottle.toString());
          }
        }
      }
    }

    // Whether we need in-memory post-processing that neither the search nor MongoDB can do
    const needsMaturity = !!(maturityFilter || sortField === 'maturity');
    const MATURITY_RANK = { declining: 0, late: 1, peak: 2, early: 3, 'not-ready': 4 };

    // ── Search: free text or a wine filter (type, country, region, appellation, grapes, vintage) ──
    const hasSearchFilters = !!(search || type || country || region || grapes || vintage || appellation);
    let found = null;
    let bottles;
    let totalCount;
    let canPaginateInDb;
    let groupsForPage = null;

    // ── HOT PATH: the default grouped cellar page (no filters, DB-sortable) ──
    // Group + paginate inside MongoDB instead of hydrating the whole cellar.
    const groupedInDb = grouped
      && !hasSearchFilters
      && !minRating && !maxRating && !maturityFilter && !reservedOnly && !extraFilters
      && ['createdAt', 'vintage', 'price', 'rating'].includes(sortField);
    if (groupedInDb) {
      ({ groupsForPage, bottles, totalCount } = await loadGroupedBottlePage({
        cellarId: req.params.id, excludeSet, onlyIds, sortField, sortDir, skip, limit,
        populate: WINE_POPULATE_CARDS,
      }));
      canPaginateInDb = false;
    }

    // Set when the page is already cut out (and totalCount known), so the
    // shared grouping / pagination below leaves it as it is.
    let pageReady = false;

    if (!groupedInDb && hasSearchFilters) {
      // ── SEARCH PATH: services/bottleSearch finds and ranks the bottles ──
      // With nothing to filter or sort in memory afterwards (rating, maturity,
      // reserved, chart filters), the ranked hits are the final order: page
      // over them, grouped or not, and load only the page's bottles. Loading
      // every hit to show 30 cost a big cellar ~4 MB and most of the request.
      const pageOnly = !minRating && !maxRating && !maturityFilter && !reservedOnly && !extraFilters
        && sortField !== 'maturity';
      found = await bottleSearch.searchBottles(search || '', {
        cellarId: req.params.id,
        type,
        countryId: country,
        regionId: region,
        appellation,
        grapeIds,
        vintage,
        sort,
        limit: 10000,  // Every match — we paginate after the in-memory filters
        offset: 0,
        withHits: pageOnly,
        version: scopeVersion([cellar.user]),
      });

      if (pageOnly) {
        let hits = found.hits;
        if (excludeSet.size > 0) hits = hits.filter(h => !excludeSet.has(h.id));
        if (onlyIds) hits = hits.filter(h => onlyIds.has(h.id));
        if (grouped) {
          // The same grouping as the in-memory path, from the hits' wine /
          // vintage / size alone: same keys, same order.
          const allGroups = groupIdenticalBottles(hits.map(h => ({
            _id: h.id, wineDefinition: h.wineDefinition, vintage: h.vintage, bottleSize: h.bottleSize,
          })));
          totalCount = allGroups.length;
          const pageGroups = allGroups.slice(skip, skip + limit);
          const docs = await loadBottlesInOrder(pageGroups.flatMap(g => g.bottles.map(b => b._id)), WINE_POPULATE_CARDS);
          const byId = new Map(docs.map(d => [d._id.toString(), d]));
          groupsForPage = pageGroups
            .map(g => ({ key: g.key, bottles: g.bottles.map(b => byId.get(b._id)).filter(Boolean) }))
            // A bottle deleted between the search and the load leaves no card.
            .filter(g => g.bottles.length > 0);
          bottles = groupsForPage.flatMap(g => g.bottles);
        } else {
          totalCount = hits.length;
          bottles = await loadBottlesInOrder(hits.slice(skip, skip + limit).map(h => h.id), WINE_POPULATE_CARDS);
        }
        pageReady = true;
      } else {
        let idsToFetch = found.ids;
        if (excludeSet.size > 0) idsToFetch = idsToFetch.filter(id => !excludeSet.has(id));
        if (onlyIds) idsToFetch = idsToFetch.filter(id => onlyIds.has(String(id)));
        bottles = await loadBottlesInOrder(idsToFetch, WINE_POPULATE_CARDS);
      }
      canPaginateInDb = false; // We paginate after in-memory filters below
    }

    if (!found && !groupedInDb) {
      // ── LIST PATH: no search — rating / maturity / reserved / chart filters or an in-memory sort ──
      const filter = {
        cellar: req.params.id,
        status: { $nin: NOT_IN_CELLAR_STATUSES }
      };

      if (excludeSet.size > 0) {
        filter._id = { $nin: [...excludeSet] };
      }
      if (onlyIds) filter._id = { $in: [...onlyIds] };

      const directSortFields = ['createdAt', 'vintage', 'price', 'rating'];
      const canSortInDb_ = directSortFields.includes(sortField);
      const needsInMemoryFilter = !!(minRating || maxRating || maturityFilter || reservedOnly || extraFilters);
      const needsInMemorySort = !canSortInDb_;
      // Grouping needs every matching bottle in memory before it can collapse
      // duplicates, so it disables DB-level pagination.
      canPaginateInDb = !needsInMemoryFilter && !needsInMemorySort && !grouped;

      let query = Bottle.find(filter).populate(WINE_POPULATE_CARDS);
      if (canSortInDb_) query = query.sort({ [sortField]: sortDir });
      if (canPaginateInDb) {
        query = query.skip(skip).limit(limit);
      } else {
        // Safety cap: an in-memory sort/group path must never hydrate an
        // unbounded populated set (a large cellar sorted by name/maturity would
        // otherwise load every active bottle into memory). Mirror the 10k cap
        // the sibling list paths use (bottles.js, cellars history, multi-cellar).
        query = query.limit(10000);
      }
      bottles = await query.lean();

      if (canPaginateInDb) {
        totalCount = await Bottle.countDocuments(filter);
      }

      // In-memory sort for fields that require populated data
      if (needsInMemorySort) {
        let maturityStatusMap_;
        if (sortField === 'maturity') {
          const profileMap = await buildProfileMap(bottles);
          maturityStatusMap_ = new Map();
          for (const b of bottles) {
            maturityStatusMap_.set(b._id.toString(), classifyMaturity(b, profileMap));
          }
        }
        bottles.sort((a, b) => {
          let aVal, bVal;
          if (sortField === 'name') {
            aVal = a.wineDefinition?.name || '';
            bVal = b.wineDefinition?.name || '';
          } else if (sortField === 'maturity' && maturityStatusMap_) {
            const aStatus = maturityStatusMap_.get(a._id.toString());
            const bStatus = maturityStatusMap_.get(b._id.toString());
            aVal = aStatus != null ? MATURITY_RANK[aStatus] : 5;
            bVal = bStatus != null ? MATURITY_RANK[bStatus] : 5;
          } else {
            aVal = a.createdAt;
            bVal = b.createdAt;
          }
          if (aVal < bVal) return -sortDir;
          if (aVal > bVal) return sortDir;
          return 0;
        });
      }
    }

    // ── Shared post-filters (applied to both the search and list paths) ──

    if (reservedOnly) {
      bottles = bottles.filter(isReserved);
    }

    bottles = applyExtraBottleFilters(bottles, extraFilters);

    if (minRating) {
      const min = parseFloat(minRating);
      bottles = bottles.filter(b => {
        if (!b.rating) return false;
        return toNormalized(b.rating, b.ratingScale || '5') >= min;
      });
    }

    if (maxRating) {
      const max = parseFloat(maxRating);
      bottles = bottles.filter(b => {
        if (!b.rating) return false;
        return toNormalized(b.rating, b.ratingScale || '5') <= max;
      });
    }

    let maturityStatusMap;
    if (needsMaturity) {
      const profileMap = await buildProfileMap(bottles);
      maturityStatusMap = new Map();
      for (const b of bottles) {
        maturityStatusMap.set(b._id.toString(), classifyMaturity(b, profileMap));
      }
    }

    if (maturityFilter && maturityStatusMap) {
      bottles = bottles.filter(b => matchesMaturityFilter(maturityStatusMap.get(b._id.toString()), maturityFilter));
    }

    // The search ranks by relevance and a stored field; maturity needs vintage
    // profiles, so a maturity sort on the search path is applied here, mirroring
    // the list path's comparator.
    if (sortField === 'maturity' && found && maturityStatusMap) {
      bottles.sort((a, b) => {
        const aStatus = maturityStatusMap.get(a._id.toString());
        const bStatus = maturityStatusMap.get(b._id.toString());
        const aVal = aStatus != null ? MATURITY_RANK[aStatus] : 5;
        const bVal = bStatus != null ? MATURITY_RANK[bStatus] : 5;
        return (aVal - bVal) * sortDir;
      });
    }

    // Group identical bottles (same wine + vintage), or paginate normally.
    // `bottles` is fully filtered + sorted here; grouping preserves that order.
    // (Skipped when the DB-grouped hot path already produced groupsForPage.)
    if (grouped && !groupsForPage && !pageReady) {
      // Wine + vintage + bottle size, so a magnum and a 750ml stay apart.
      const allGroups = groupIdenticalBottles(bottles);
      totalCount = allGroups.length;                  // total = number of groups
      groupsForPage = allGroups.slice(skip, skip + limit);
      bottles = groupsForPage.flatMap(g => g.bottles); // flatten so image attach below works
    } else if (!canPaginateInDb && !groupsForPage && !pageReady) {
      totalCount = bottles.length;
      bottles = bottles.slice(skip, skip + limit);
    }

    // Image resolution is attachBottleImageUrls' job — this route used to carry
    // its own copy of the same logic, which is exactly how the two drifted apart
    // (the copy matched pending photos on bottle only, the helper's sibling route
    // on bottle or wine). One implementation, one behaviour.
    const withImages = await attachBottleImageUrls(bottles, req.user.id);
    const bottleItems = withImages.map(b => ({
      ...b,
      ...(maturityStatusMap ? { maturityStatus: maturityStatusMap.get(b._id.toString()) || null } : {})
    }));

    // When grouping, re-nest the image-resolved bottles into their groups so the
    // response is one entry per (wine + vintage) carrying its member bottles.
    let responseItems = bottleItems;
    if (grouped && groupsForPage) {
      const itemById = new Map(bottleItems.map(it => [it._id.toString(), it]));
      responseItems = groupsForPage.map(g => {
        const members = g.bottles.map(b => itemById.get(b._id.toString())).filter(Boolean);
        return { key: g.key, count: members.length, bottles: members };
      });
    }

    // ── Facets for the filter modal ──
    // baseFacets: every option in the cellar, so the user can always add a selection;
    // facets: the counts under the current search + filters, for cascading.
    // The search above counted both; a plain page counts them in one grouping query.
    const facetSource = found || await bottleSearch.bottleFacets({ cellarId: req.params.id });
    const baseFacets = facetSource.baseFacetDistribution;
    // The rack / group filter is not something the search counts, so cascading
    // counts cannot reflect it; send no counts rather than whole-cellar numbers
    // beside a scoped list (audit 2026-09-07).
    const facets = onlyIds ? null : facetSource.facetDistribution;
    const facetMeta = facetSource.facetMeta;

    // Bottles bought for this cellar that have not arrived yet: the page
    // shows a link to them (GET /:id/on-order) instead of mixing them into
    // the list. One indexed count; the next date only when there are any.
    // Auxiliary: a failed lookup degrades to "no link", never a 500 page.
    let onOrderCount = 0;
    let nextExpected = null;
    try {
      onOrderCount = await Bottle.countDocuments({ cellar: req.params.id, status: ORDERED_STATUS });
      if (onOrderCount > 0) {
        const next = await Bottle.findOne({ cellar: req.params.id, status: ORDERED_STATUS, expectedArrival: { $ne: null } })
          .sort({ expectedArrival: 1 }).select('expectedArrival').lean();
        nextExpected = next?.expectedArrival || null;
      }
    } catch (err) {
      console.warn('On-order summary failed (non-fatal):', err.message);
    }

    res.json({
      cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
      onOrder: { count: onOrderCount, nextExpected },
      bottles: {
        total: totalCount,
        count: responseItems.length,
        limit,
        skip,
        grouped,
        items: responseItems
      },
      ...(facets ? { facets, baseFacets, facetMeta } : {})
    });
  } catch (error) {
    console.error('Get cellar error:', error);
    res.status(500).json({ error: 'Failed to get cellar' });
  }
});

// PUT /api/cellars/:id - Update cellar (owner only)
router.put('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { name, description } = req.body;

    const cellar = await Cellar.findOne({
      _id: req.params.id,
      user: req.user.id,
      deletedAt: null
    });

    if (!cellar) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    if (name) cellar.name = name.trim();
    if (description !== undefined) cellar.description = description?.trim() || '';

    await cellar.save();

    logAudit(req, 'cellar.update', { type: 'cellar', id: cellar._id, cellarId: cellar._id }, { name: cellar.name });

    const obj = cellar.toObject();
    obj.userRole = 'owner';
    obj.userColor = getUserColor(cellar, req.user.id);
    res.json({ cellar: obj });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'You already have a cellar with this name' });
    }
    console.error('Update cellar error:', error);
    res.status(500).json({ error: 'Failed to update cellar' });
  }
});

// PATCH /api/cellars/:id/color - Set personal color preference (any role)
router.patch('/:id/color', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { color } = req.body; // hex string or null/empty to clear
    const cellar = await Cellar.findById(req.params.id);
    const role = getCellarRole(cellar, req.user.id);
    // deletedAt: soft-deleted cellars are frozen until restore, like the
    // sibling PUT/DELETE routes enforce.
    if (!role || cellar.deletedAt) return res.status(404).json({ error: 'Cellar not found' });

    const idx = cellar.userColors.findIndex(
      uc => uc.user.toString() === req.user.id.toString()
    );
    if (color) {
      if (idx >= 0) {
        cellar.userColors[idx].color = color;
      } else {
        cellar.userColors.push({ user: req.user.id, color });
      }
    } else {
      if (idx >= 0) cellar.userColors.splice(idx, 1);
    }

    await cellar.save();
    res.json({ userColor: color || null });
  } catch (error) {
    console.error('Set cellar color error:', error);
    res.status(500).json({ error: 'Failed to set color' });
  }
});

// DELETE /api/cellars/:id - Soft-delete cellar (owner only); data retained 30 days
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findOne({
      _id: req.params.id,
      user: req.user.id,
      deletedAt: null
    });

    if (!cellar) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    const now = new Date();
    cellar.deletedAt = now;
    await cellar.save();

    // Cascade soft-delete to the LIVE racks only ({ deletedAt: null }). Racks
    // the user already soft-deleted individually keep their own (earlier)
    // deletedAt — restamping "now" would reset their 30-day purge clock, and a
    // later restore would flip them back as zombie racks the user had removed
    // (grand-audit M13). Restore below re-activates only racks stamped with
    // this exact timestamp, so the two sets never mix.
    // Also free NFC tags: the rfidTag unique index has no deletedAt filter, so
    // a soft-deleted rack would keep its tag claimed (blocking re-link on
    // another rack) until the retention purge (grand-audit L14).
    await Rack.updateMany({ cellar: cellar._id, deletedAt: null }, { $set: { deletedAt: now }, $unset: { rfidTag: '' } });

    // Wine lists and the 3D room layout are intentionally NOT removed here:
    // this is a reversible soft-delete (restorable for 30 days), so curated
    // lists (incl. their logo files) and the rack arrangement must survive
    // for restore. Both are hard-deleted by the permanent-delete cascade
    // (services/cellarPurge.js) — and the public wine-list routes 404 while
    // the cellar is soft-deleted, so nothing stays reachable meanwhile.

    // Withdraw the cellar's pending wine requests from the admin queue. A
    // deleted cellar's requests used to linger as ghosts a curator could
    // spend real time on (131 of them after one abandoned import,
    // 2026-08-28) — and resolving one would have bound bottles the user had
    // already thrown away. Withdrawn, not rejected: rejection notifies the
    // user and detaches their bottles; a user deleting their own cellar has
    // asked for neither. Stamped with the cellar's own deletedAt (the rack
    // cascade's exact-timestamp pattern) so restore re-pends precisely these.
    // Only requests whose EVERY referencing bottle is inside this cellar —
    // a request also feeding another cellar's bottles must stay pending.
    const reqIds = await Bottle.distinct('pendingWineRequest', {
      cellar: cellar._id, pendingWineRequest: { $ne: null },
    });
    if (reqIds.length > 0) {
      const elsewhere = await Bottle.distinct('pendingWineRequest', {
        cellar: { $ne: cellar._id }, pendingWineRequest: { $in: reqIds },
      });
      const elsewhereSet = new Set(elsewhere.map(String));
      const onlyHere = reqIds.filter((id) => !elsewhereSet.has(String(id)));
      if (onlyHere.length > 0) {
        await WineRequest.updateMany(
          { _id: { $in: onlyHere }, status: 'pending' },
          { $set: { status: 'withdrawn', withdrawnAt: now } }
        );
      }
    }

    // Bottles are preserved — they remain in history via their status field

    logAudit(req, 'cellar.delete',
      { type: 'cellar', id: cellar._id, cellarId: cellar._id },
      { name: cellar.name }
    );

    res.json({ message: 'Cellar deleted' });
  } catch (error) {
    console.error('Delete cellar error:', error);
    res.status(500).json({ error: 'Failed to delete cellar' });
  }
});

// POST /api/cellars/:id/members - Add a member (owner only)
// requireNonDemo: inviting a member sends an email to an arbitrary address — an
// outbound-email/PII spam vector a throwaway demo must not have. A demo user can
// explore a populated cellar but can't invite others to it.
// Audit 2026-09 D11-1: invitations per account per rolling 24 h. A household
// shares a handful of cellars with a handful of people; twenty is generous.
const INVITES_PER_DAY = 20;

router.post('/:id/members', requireNonDemo, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'email and role are required' });
    }
    if (!['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'role must be viewer or editor' });
    }

    // deletedAt: null — inviting to a soft-deleted cellar fired invite
    // emails/notifications pointing at a cellar the invitee can never see.
    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id, deletedAt: null });
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const normalizedEmail = String(email).toLowerCase().trim();
    // Audit 2026-09 D11-1: the invite path relays attacker-chosen text (the
    // cellar name) to any mailbox. Only real addresses, and no more than
    // INVITES_PER_DAY invitations per account per rolling day.
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }

    // Look up user by email
    const userToAdd = await User.findOne({ email: normalizedEmail });

    // Can't share with yourself
    if (userToAdd && userToAdd._id.toString() === req.user.id.toString()) {
      return res.status(400).json({ error: 'Cannot share a cellar with yourself' });
    }

    if (!userToAdd) {
      // User doesn't exist — create a pending invite and send an email
      const existingPending = await PendingShare.findOne({ email: normalizedEmail, cellar: cellar._id });
      if (existingPending) {
        return res.status(400).json({ error: 'An invitation has already been sent to this email' });
      }

      const sentToday = await PendingShare.countDocuments({ invitedBy: req.user.id, createdAt: { $gte: new Date(Date.now() - 24 * 3600e3) } });
      if (sentToday >= INVITES_PER_DAY) {
        logAudit(req, 'system.rate_limit_exceeded', { type: 'cellar', id: cellar._id }, { limiter: 'cellarInvites', limit: INVITES_PER_DAY });
        return res.status(429).json({ error: 'Too many invitations sent today. Please try again tomorrow.' });
      }

      const sharingUser = await User.findById(req.user.id).select('username email').lean();

      await PendingShare.create({
        email: normalizedEmail,
        cellar: cellar._id,
        role,
        invitedBy: req.user.id
      });

      sendCellarInviteEmail(
        normalizedEmail,
        sharingUser?.username ?? 'A Cellarion user',
        sharingUser?.email ?? '',
        String(cellar.name || '').slice(0, 100),
        role
      ).catch(err => {
        console.error('Failed to send cellar invite email:', err.message);
      });

      logAudit(req, 'cellar.share.invite',
        { type: 'cellar', id: cellar._id, cellarId: cellar._id },
        { invitedEmail: normalizedEmail, role }
      );

      return res.status(202).json({
        invited: true,
        message: `Invitation sent to ${normalizedEmail}. The cellar will be shared when they join Cellarion.`
      });
    }

    // Check if already a member
    const alreadyMember = cellar.members.some(
      m => m.user.toString() === userToAdd._id.toString()
    );
    if (alreadyMember) {
      return res.status(400).json({ error: 'User is already a member of this cellar' });
    }

    cellar.members.push({ user: userToAdd._id, role });
    await cellar.save();

    const sharingUser = await User.findById(req.user.id).select('username').lean();
    createNotification(
      userToAdd._id,
      'cellar_shared',
      'Cellar shared with you',
      `${sharingUser?.username ?? 'Someone'} shared their cellar "${cellar.name}" with you (${role}).`,
      '/cellars'
    );

    logAudit(req, 'cellar.share.add',
      { type: 'cellar', id: cellar._id, cellarId: cellar._id },
      { sharedWith: userToAdd.email, role }
    );

    await cellar.populate('members.user', 'username email');
    res.status(201).json({ members: cellar.members });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// PUT /api/cellars/:id/members/:userId - Change a member's role (owner only)
router.put('/:id/members/:userId', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid ID' });
    const { role } = req.body;
    if (!role || !['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'role must be viewer or editor' });
    }

    const cellar = await Cellar.findOne({ _id: req.params.id, user: req.user.id, deletedAt: null });
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const member = cellar.members.find(m => m.user.toString() === req.params.userId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const previousRole = member.role;
    member.role = role;
    await cellar.save();

    // Assigning a climate device to a cellar requires owner/editor. If this
    // member is downgraded to viewer, detach any device they had assigned here
    // so a demoted collaborator can't keep writing readings into the cellar.
    if (previousRole === 'editor' && role === 'viewer') {
      await ClimateDevice.updateMany(
        { cellar: cellar._id, user: req.params.userId },
        { $set: { cellar: null } }
      );
    }

    logAudit(req, 'cellar.share.update',
      { type: 'cellar', id: cellar._id, cellarId: cellar._id },
      { memberId: req.params.userId, from: previousRole, to: role }
    );

    await cellar.populate('members.user', 'username email');
    res.json({ members: cellar.members });
  } catch (error) {
    console.error('Update member role error:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
});

// DELETE /api/cellars/:id/members/:userId - Remove a member (owner, or self-removal)
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findById(req.params.id);
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const isOwner = cellar.user.toString() === req.user.id.toString();
    const isSelf = req.params.userId === req.user.id.toString();
    if (!isOwner && !isSelf) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const memberIndex = cellar.members.findIndex(
      m => m.user.toString() === req.params.userId
    );
    if (memberIndex === -1) return res.status(404).json({ error: 'Member not found' });

    cellar.members.splice(memberIndex, 1);
    await cellar.save();

    // Detach any climate devices the removed member had assigned to this
    // cellar — otherwise their token keeps posting readings into a cellar they
    // no longer have access to, and their alerts keep leaking its live name and
    // thresholds (device assignment was role-checked only at assignment time).
    await ClimateDevice.updateMany(
      { cellar: cellar._id, user: req.params.userId },
      { $set: { cellar: null } }
    );

    logAudit(req, 'cellar.share.remove',
      { type: 'cellar', id: cellar._id, cellarId: cellar._id },
      { removedUserId: req.params.userId }
    );

    res.json({ message: 'Member removed successfully' });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// GET /api/cellars/:id/audit - Per-cellar audit log (owner only)
router.get('/:id/audit', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    // 404 for missing/deleted cellars, 403 only when it exists and the
    // requester isn't the owner (audit log stays owner-only, and frozen
    // while soft-deleted like the other cellar views).
    const cellar = await Cellar.findOne({ _id: req.params.id, deletedAt: null });
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });
    if (cellar.user.toString() !== req.user.id.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Return a MINIMISED projection (security audit M-2): the raw AuditLog docs
    // carry actor.ipAddress, userAgent, and the actor's email — a cellar owner
    // must not harvest collaborators' (incl. former collaborators', and any
    // admin/somm actor's) IP + email. The app's own token layer already blocks
    // this path for API tokens (apiTokenAuth TOKEN_EXCLUSIONS, "audit log incl.
    // collaborator IPs and emails"); apply the same discipline to the web path.
    // Populate username only, and drop ip/userAgent/email before responding.
    const raw = await AuditLog.find({ 'resource.cellarId': req.params.id })
      .sort({ timestamp: -1 })
      .limit(100)
      .populate('actor.userId', 'username')
      .lean();

    const logs = raw.map((l) => ({
      _id: l._id,
      action: l.action,
      detail: l.detail,
      timestamp: l.timestamp,
      actor: { userId: l.actor?.userId ? { username: l.actor.userId.username } : null },
    }));

    res.json({ logs });
  } catch (error) {
    console.error('Get cellar audit error:', error);
    res.status(500).json({ error: 'Failed to get audit log' });
  }
});

// POST /:id/transfer-ownership — hand the cellar to another member.
//
// The outgoing owner stays on as an editor, which is the point: the workflow
// this serves is "build it for someone, then give it to them and keep helping".
// requireNonDemo because the demo account must not be able to hand its cellar
// to a real user, nor a real user park a cellar on it.
router.post('/:id/transfer-ownership', requireNonDemo, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { newOwnerId } = req.body || {};
    if (!newOwnerId || !isValidId(newOwnerId)) {
      return res.status(400).json({ error: 'newOwnerId is required' });
    }

    const result = await transferCellarOwnership(req.params.id, newOwnerId, req.user.id);

    logAudit(
      req,
      'cellar.transferOwnership',
      { type: 'cellar', id: result.cellar._id, cellarId: result.cellar._id },
      {
        name: result.cellar.name,
        from: result.previousOwner,
        to: result.newOwner,
        bottlesMoved: result.bottlesMoved,
        racksMoved: result.racksMoved,
      },
    );

    // The recipient did not ask for this at the moment it happened, so tell
    // them plainly what they now hold and what it cost the other party.
    createNotification(
      result.newOwner,
      'cellar_ownership_received',
      'You now own a cellar',
      `"${result.cellar.name}" has been transferred to you, with ${result.bottlesMoved} bottle(s). The previous owner remains an editor.`,
      `/cellars/${result.cellar._id}`,
    ).catch((err) => console.error('[cellars] transfer notification failed:', err.message));

    res.json({
      cellar: { _id: result.cellar._id, name: result.cellar.name, user: result.cellar.user },
      bottlesMoved: result.bottlesMoved,
      racksMoved: result.racksMoved,
      newOwner: { _id: result.newOwner, username: result.newOwnerName },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Transfer cellar ownership error:', err);
    res.status(500).json({ error: 'Failed to transfer ownership' });
  }
});

module.exports = router;
// Exported for its unit test (routes/cellars.pendingImage.test.js).
module.exports.attachBottleImageUrls = attachBottleImageUrls;
