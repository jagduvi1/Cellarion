const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
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
const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');
const { isReserved } = require('../utils/reservationUtils');
const { CONSUMED_STATUSES, WINE_POPULATE_LIST } = require('../config/constants');
const mongoose = require('mongoose');
const { parsePagination } = require('../utils/pagination');
const searchService = require('../services/search');
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
async function loadGroupedBottlePage({ cellarId, excludeSet, sortField, sortDir, skip, limit }) {
  const { ObjectId } = mongoose.Types;
  const match = {
    cellar: new ObjectId(String(cellarId)),
    status: { $nin: CONSUMED_STATUSES },
  };
  if (excludeSet.size > 0) {
    match._id = { $nin: [...excludeSet].map(id => new ObjectId(id)) };
  }
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
    .populate(WINE_POPULATE_LIST)
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

// Resolve every cellar the user can read (owned + shared), as lean docs.
async function resolveAccessibleCellars(userId) {
  return Cellar.find({
    $or: [{ user: userId }, { 'members.user': userId }],
    deletedAt: null,
  }).lean();
}

const MATURITY_RANK_MULTI = { declining: 0, late: 1, peak: 2, early: 3, 'not-ready': 4 };

async function queryBottlesAcrossCellars(req, { cellarIds, statusFilter, paginate = true }) {
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
  const maturityFilter = coerceStringQuery(req.query.maturity);
  const sort = coerceStringQuery(req.query.sort) || '-createdAt';
  const { limit, offset: skip } = parsePagination(req.query, { limit: 30, maxLimit: 200 });
  const { isValidObjectId } = mongoose;
  const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
  const sortDir = sort.startsWith('-') ? -1 : 1;
  const grapeIds = grapes
    ? String(grapes).split(',').map(g => g.trim()).filter(isValidObjectId)
    : [];
  const hasMeiliFilters = !!(search || type || country || region || grapes || vintage || appellation);
  const needsMaturity = statusFilter !== 'consumed' && !!(maturityFilter || sortField === 'maturity');
  const statusMongo = statusFilter === 'consumed'
    ? { $in: CONSUMED_STATUSES }
    : { $nin: CONSUMED_STATUSES };
  const objectIds = cellarIds.map(id => new mongoose.Types.ObjectId(id));

  // ── HOT PATH: default view (no search/filters, DB-sortable) ──
  // Paginate inside MongoDB instead of hydrating up to 10k populated bottles to
  // slice a 30-item page. Mirrors the single-cellar route's canPaginateInDb;
  // trivially correct here since the cross-cellar view never groups.
  const canPaginateInDb = paginate
    && !hasMeiliFilters
    && !minRating && !maxRating && !maturityFilter
    && ['createdAt', 'vintage', 'price', 'rating'].includes(sortField);
  if (canPaginateInDb) {
    const filter = { cellar: { $in: objectIds }, status: statusMongo };
    const [pageDocs, totalCount] = await Promise.all([
      Bottle.find(filter).populate(WINE_POPULATE_LIST).sort({ [sortField]: sortDir }).skip(skip).limit(limit).lean(),
      Bottle.countDocuments(filter),
    ]);
    return { items: pageDocs, total: totalCount, limit, skip, maturityStatusMap: null };
  }

  let bottles;
  let usedMeili = false;

  // ── PRIMARY: Meilisearch across the cellar set (typo tolerance) ──
  if (searchService.getIsAvailable() && hasMeiliFilters) {
    try {
      const meiliResult = await searchService.searchBottles(search || '', {
        cellarIds,
        type: type || undefined,
        countryId: country || undefined,
        regionId: region || undefined,
        appellation: appellation || undefined,
        grapeIds: grapeIds.length > 0 ? grapeIds : undefined,
        vintage: vintage || undefined,
        statusFilter,
        sort,
        limit: 10000,
        offset: 0,
      });
      const ids = meiliResult.ids;
      if (ids.length === 0) {
        bottles = [];
      } else {
        bottles = await Bottle.find({ _id: { $in: ids } }).populate(WINE_POPULATE_LIST).lean();
        const order = new Map(ids.map((id, i) => [id, i]));
        bottles.sort((a, b) => (order.get(a._id.toString()) ?? 0) - (order.get(b._id.toString()) ?? 0));
      }
      usedMeili = true;
    } catch {
      // fall through to MongoDB
    }
  }

  // ── FALLBACK: MongoDB + in-memory (Meili unavailable or errored) ──
  if (!usedMeili) {
    const filter = { cellar: { $in: objectIds }, status: statusMongo };
    if (vintage) {
      const vs = String(vintage).split(',').map(v => v.trim()).filter(Boolean);
      filter.vintage = vs.length === 1 ? vs[0] : { $in: vs };
    }
    const wdFilter = {};
    if (country) {
      const ids = String(country).split(',').map(c => c.trim()).filter(isValidObjectId);
      if (ids.length === 1) wdFilter.country = ids[0];
      else if (ids.length > 1) wdFilter.country = { $in: ids };
    }
    if (region) {
      const ids = String(region).split(',').map(r => r.trim()).filter(isValidObjectId);
      if (ids.length === 1) wdFilter.region = ids[0];
      else if (ids.length > 1) wdFilter.region = { $in: ids };
    }
    if (type) {
      const types = String(type).split(',').map(t => t.trim()).filter(Boolean);
      wdFilter.type = types.length === 1 ? types[0] : { $in: types };
    }
    if (appellation) {
      const apps = String(appellation).split(',').map(a => a.trim()).filter(Boolean);
      if (apps.length > 0) wdFilter.appellation = apps.length === 1 ? apps[0] : { $in: apps };
    }
    if (grapeIds.length > 0) wdFilter.grapes = { $in: grapeIds };
    if (Object.keys(wdFilter).length > 0) {
      const matchingWdIds = await WineDefinition.find(wdFilter).distinct('_id');
      if (matchingWdIds.length === 0) return { items: [], total: 0, limit, skip, maturityStatusMap: null };
      filter.wineDefinition = { $in: matchingWdIds };
    }
    bottles = await Bottle.find(filter)
      .populate(WINE_POPULATE_LIST)
      // Cap on the field we ultimately order by, so a >10k set keeps the right
      // slice: newest-consumed for history, newest-added for active bottles.
      .sort(statusFilter === 'consumed' ? { consumedAt: -1 } : { createdAt: -1 })
      .limit(10000)
      .lean();
    if (search) {
      const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const words = stripAccents(search.toLowerCase()).split(/\s+/).filter(Boolean);
      bottles = bottles.filter(b => {
        const allText = [
          b.wineDefinition?.name, b.wineDefinition?.producer, b.notes, b.location, b.consumedNote,
          b.wineDefinition?.country?.name, b.wineDefinition?.region?.name,
          b.wineDefinition?.appellation, b.wineDefinition?.type,
          ...(b.wineDefinition?.grapes || []).map(g => g.name),
        ].filter(Boolean).map(s => stripAccents(s.toLowerCase())).join(' ');
        return words.every(word => allText.includes(word));
      });
    }
  }

  // ── Shared post-filters (rating + maturity), applied to both paths ──
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
    bottles = maturityFilter === 'none'
      ? bottles.filter(b => maturityStatusMap.get(b._id.toString()) == null)
      : bottles.filter(b => maturityStatusMap.get(b._id.toString()) === maturityFilter);
  }

  // ── Sort ──
  if (statusFilter === 'consumed') {
    // History is a chronological view — newest-consumed first, always.
    bottles.sort((a, b) => new Date(b.consumedAt || 0) - new Date(a.consumedAt || 0));
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
  } else if (!usedMeili) {
    // Meili already sorted its supported fields; the Mongo path sorts here.
    bottles.sort((a, b) => {
      const av = a[sortField] ?? 0;
      const bv = b[sortField] ?? 0;
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });
  }

  const total = bottles.length;
  const items = paginate ? bottles.slice(skip, skip + limit) : bottles;
  return { items, total, limit, skip, maturityStatusMap };
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

  const pendingImages = await BottleImage.find({
    $or: [
      { bottle: { $in: bottleIds } },
      ...(wineIds.length ? [{ wineDefinition: { $in: wineIds } }] : []),
    ],
    uploadedBy: userId,
    status: { $in: ['uploaded', 'processing', 'processed'] },
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
    if (img.wineDefinition && !pendingByWine[img.wineDefinition.toString()]) {
      pendingByWine[img.wineDefinition.toString()] = url;
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
async function facetsAcrossCellars(req, { cellarIds, statusFilter }) {
  const { search, type, country, region, grapes, vintage, appellation } = req.query;
  const { isValidObjectId } = mongoose;
  const grapeIds = grapes
    ? String(grapes).split(',').map(g => g.trim()).filter(isValidObjectId)
    : [];
  const hasMeiliFilters = !!(search || type || country || region || grapes || vintage || appellation);
  const statusMongo = statusFilter === 'consumed'
    ? { $in: CONSUMED_STATUSES }
    : { $nin: CONSUMED_STATUSES };

  let facets = null, baseFacets = null, facetMeta = null;
  if (searchService.getIsAvailable()) {
    try {
      const baseResult = await searchService.searchBottles('', { cellarIds, statusFilter, limit: 0, offset: 0 });
      baseFacets = baseResult.facetDistribution || null;
      if (hasMeiliFilters) {
        const filteredResult = await searchService.searchBottles(search || '', {
          cellarIds, statusFilter,
          type: type || undefined, countryId: country || undefined, regionId: region || undefined,
          appellation: appellation || undefined,
          grapeIds: grapeIds.length > 0 ? grapeIds : undefined, vintage: vintage || undefined,
          limit: 0, offset: 0,
        });
        facets = filteredResult.facetDistribution || null;
      } else {
        facets = baseFacets;
      }
    } catch { /* skip facets */ }
  }
  if (baseFacets || facets) {
    const objectIds = cellarIds.map(id => new mongoose.Types.ObjectId(id));
    const wdIds = await Bottle.find({ cellar: { $in: objectIds }, status: statusMongo }).distinct('wineDefinition');
    const wds = await WineDefinition.find({ _id: { $in: wdIds } })
      .populate('country', 'name').populate('region', 'name').populate('grapes', 'name').lean();
    const countries = {}, regions = {}, grapesMap = {};
    for (const wd of wds) {
      if (wd.country?.name && wd.country._id) countries[wd.country.name] = wd.country._id.toString();
      if (wd.region?.name && wd.region._id) regions[wd.region.name] = wd.region._id.toString();
      for (const g of (wd.grapes || [])) {
        if (g.name && g._id) grapesMap[g.name] = g._id.toString();
      }
    }
    facetMeta = { countries, regions, grapes: grapesMap };
  }
  return { facets, baseFacets, facetMeta };
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

    const result = await queryBottlesAcrossCellars(req, { cellarIds, statusFilter: 'active' });
    const { total, limit, skip, maturityStatusMap } = result;
    let items = result.items;
    // Facets only change the filter modal, which the client reads on the first
    // page only — skip the extra Meili + distinct queries on every Load More.
    const { facets, baseFacets, facetMeta } = skip === 0
      ? await facetsAcrossCellars(req, { cellarIds, statusFilter: 'active' })
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

    res.json({
      cellars: cellarIds.map(id => {
        const c = accessibleMap.get(id);
        return { _id: id, name: c.name, userColor: getUserColor(c, req.user.id) };
      }),
      bottles: { count: items.length, total, limit, skip, items },
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

    const { items } = await queryBottlesAcrossCellars(req, { cellarIds, statusFilter: 'consumed', paginate: false });
    const { facets, baseFacets, facetMeta } = await facetsAcrossCellars(req, { cellarIds, statusFilter: 'consumed' });

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

    // Only count active bottles in statistics. This handler reads only scalar
    // bottle fields plus wineDefinition.type and wineDefinition.country.name, so
    // populate just those — the full WINE_POPULATE_LIST also joins region + the
    // grapes array (never read here), pure waste on large cellars. Capped at 10k
    // to match the sibling list/history routes.
    const bottles = await Bottle.find({
      cellar: req.params.id,
      status: { $nin: CONSUMED_STATUSES }
    })
      .populate({
        path: 'wineDefinition',
        select: 'type country',
        populate: { path: 'country', select: 'name' },
      })
      .limit(10000)
      .lean();

    // Batch-load historical rate snapshots for all priceSetAt dates (one DB query)
    const targetCurrency = req.query.currency || null;
    let snapshotMap = new Map();
    let todaySnapshot = null;
    if (targetCurrency) {
      const priceDates = [...new Set(
        bottles
          .filter(b => b.price && b.priceSetAt)
          .map(b => b.priceSetAt.toISOString().slice(0, 10))
      )];
      if (priceDates.length > 0) {
        snapshotMap = await getSnapshotsForDates(priceDates);
      }
      // Fetch today's snapshot as fallback for bottles without priceSetAt
      todaySnapshot = await getOrCreateDailySnapshot();
    }

    // Calculate statistics
    const stats = {
      totalBottles: bottles.length,
      // Bottles awaiting a wine request have no wineDefinition — exclude them
      // rather than letting `undefined` count as one extra "unique wine".
      uniqueWines: new Set(
        bottles.filter(b => b.wineDefinition?._id).map(b => b.wineDefinition._id.toString())
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

    bottles.forEach(bottle => {
      // Total value calculation
      if (bottle.price) {
        const currency = bottle.currency || 'USD';
        stats.totalValue += bottle.price;
        priceSum += bottle.price;
        priceCount++;

        // Currency-converted total: bottles already in the target currency are
        // used as-is; others are converted using the historical rate from the
        // day the price was entered, falling back to today's rates.
        if (targetCurrency) {
          if (currency === targetCurrency) {
            convertedSum += bottle.price;
            convertedCount++;
          } else {
            const dateKey = bottle.priceSetAt
              ? bottle.priceSetAt.toISOString().slice(0, 10)
              : null;
            const rates = (dateKey && snapshotMap.get(dateKey))
              || (todaySnapshot ? todaySnapshot.rates : null);
            const converted = convertCurrency(bottle.price, currency, targetCurrency, rates);
            if (converted !== null) {
              convertedSum += converted;
              convertedCount++;
            }
          }
        }
      }

      // By country
      const countryName = bottle.wineDefinition?.country?.name || 'Unknown';
      stats.byCountry[countryName] = (stats.byCountry[countryName] || 0) + 1;

      // By type
      const type = bottle.wineDefinition?.type || 'Unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;

      // By vintage
      const vintage = bottle.vintage || 'NV';
      stats.byVintage[vintage] = (stats.byVintage[vintage] || 0) + 1;

      // Track oldest/newest vintage
      if (vintage !== 'NV') {
        const year = parseInt(vintage);
        if (!isNaN(year)) {
          if (year < oldestYear) oldestYear = year;
          if (year > newestYear) newestYear = year;
        }
      }

      // By rating — normalize to 0-100 and bucket into 5 bands
      if (bottle.rating) {
        const norm = toNormalized(bottle.rating, bottle.ratingScale || '5');
        const band = norm <= 20 ? '0-20' : norm <= 40 ? '21-40' : norm <= 60 ? '41-60' : norm <= 80 ? '61-80' : '81-100';
        stats.byRating[band] = (stats.byRating[band] || 0) + 1;
      }
    });

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
    const { isValidObjectId } = mongoose;

    // Base query: consumed bottles in this cellar
    const filter = { cellar: req.params.id, status: { $in: CONSUMED_STATUSES } };
    if (vintage) {
      const vintages = String(vintage).split(',').map(v => v.trim()).filter(Boolean);
      filter.vintage = vintages.length === 1 ? vintages[0] : { $in: vintages };
    }

    // Taxonomy pre-query
    const wdFilter = {};
    if (country) {
      const ids = String(country).split(',').map(c => c.trim()).filter(isValidObjectId);
      if (ids.length === 1) wdFilter.country = ids[0];
      else if (ids.length > 1) wdFilter.country = { $in: ids };
    }
    if (region) {
      const ids = String(region).split(',').map(r => r.trim()).filter(isValidObjectId);
      if (ids.length === 1) wdFilter.region = ids[0];
      else if (ids.length > 1) wdFilter.region = { $in: ids };
    }
    if (type) {
      const types = String(type).split(',').map(t => t.trim()).filter(Boolean);
      wdFilter.type = types.length === 1 ? types[0] : { $in: types };
    }
    if (appellation) {
      const apps = String(appellation).split(',').map(a => a.trim()).filter(Boolean);
      if (apps.length > 0) wdFilter.appellation = apps.length === 1 ? apps[0] : { $in: apps };
    }
    if (grapes) {
      const grapeIds = String(grapes).split(',').map(g => g.trim()).filter(isValidObjectId);
      if (grapeIds.length > 0) wdFilter.grapes = { $in: grapeIds };
    }
    if (Object.keys(wdFilter).length > 0) {
      const matchingWdIds = await WineDefinition.find(wdFilter).distinct('_id');
      if (matchingWdIds.length === 0) {
        const cellarObj = cellar.toObject();
        cellarObj.userRole = role;
        cellarObj.userColor = getUserColor(cellar, req.user.id);
        return res.json({ cellar: cellarObj, bottles: [], facets: null, baseFacets: null, facetMeta: null });
      }
      filter.wineDefinition = { $in: matchingWdIds };
    }

    const grapeIds = grapes
      ? String(grapes).split(',').map(g => g.trim()).filter(isValidObjectId)
      : [];
    const hasMeiliFilters = !!(search || type || country || region || grapes || vintage || appellation);

    // Try Meilisearch for text search (typo tolerance)
    let usedMeili = false;
    let bottles;
    if (searchService.getIsAvailable() && hasMeiliFilters) {
      try {
        const meiliResult = await searchService.searchBottles(search || '', {
          cellarId: req.params.id,
          type: type || undefined,
          countryId: country || undefined,
          regionId: region || undefined,
          appellation: appellation || undefined,
          grapeIds: grapeIds.length > 0 ? grapeIds : undefined,
          vintage: vintage || undefined,
          statusFilter: 'consumed',
          limit: 10000, offset: 0
        });

        const matchingIds = meiliResult.ids;
        if (matchingIds.length === 0) {
          const cellarObj = cellar.toObject();
          cellarObj.userRole = role;
          cellarObj.userColor = getUserColor(cellar, req.user.id);
          return res.json({ cellar: cellarObj, bottles: [], facets: meiliResult.facetDistribution || null, baseFacets: null, facetMeta: null });
        }

        bottles = await Bottle.find({ _id: { $in: matchingIds } })
          .populate(WINE_POPULATE_LIST).lean();

        // History is a chronological view — order newest-consumed-first, same
        // as the MongoDB fallback below, rather than Meili relevance order.
        bottles.sort((a, b) => new Date(b.consumedAt || 0) - new Date(a.consumedAt || 0));
        usedMeili = true;
      } catch {
        // Fall through to MongoDB
      }
    }

    if (!usedMeili) {
      // Cap the fallback fetch at the same ceiling as the Meili path (10k) so a
      // cellar with a huge consumed history can't load the entire collection
      // into memory on every request.
      bottles = await Bottle.find(filter)
        .populate(WINE_POPULATE_LIST)
        .sort({ consumedAt: -1 })
        .limit(10000)
        .lean();

      // In-memory text search fallback
      if (search) {
        const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const words = stripAccents(search.toLowerCase()).split(/\s+/).filter(Boolean);
        bottles = bottles.filter(b => {
          const allText = [
            b.wineDefinition?.name, b.wineDefinition?.producer,
            b.notes, b.consumedNote,
            b.wineDefinition?.country?.name, b.wineDefinition?.region?.name,
            b.wineDefinition?.appellation, b.wineDefinition?.type,
            ...(b.wineDefinition?.grapes || []).map(g => g.name)
          ].filter(Boolean).map(s => stripAccents(s.toLowerCase())).join(' ');
          return words.every(word => allText.includes(word));
        });
      }
    }

    // Facets from Meilisearch
    let facets = null, baseFacets = null, facetMeta = null;
    if (searchService.getIsAvailable()) {
      try {
        const baseResult = await searchService.searchBottles('', {
          cellarId: req.params.id, statusFilter: 'consumed', limit: 0, offset: 0
        });
        baseFacets = baseResult.facetDistribution || null;

        if (hasMeiliFilters) {
          const filteredResult = await searchService.searchBottles(search || '', {
            cellarId: req.params.id, statusFilter: 'consumed',
            type: type || undefined, countryId: country || undefined,
            regionId: region || undefined, appellation: appellation || undefined,
            grapeIds: grapeIds.length > 0 ? grapeIds : undefined,
            vintage: vintage || undefined,
            limit: 0, offset: 0
          });
          facets = filteredResult.facetDistribution || null;
        } else {
          facets = baseFacets;
        }
      } catch { /* skip facets */ }
    }

    // Build facetMeta
    if (baseFacets || facets) {
      const wdIds = await Bottle.find({ cellar: req.params.id, status: { $in: CONSUMED_STATUSES } }).distinct('wineDefinition');
      const wds = await WineDefinition.find({ _id: { $in: wdIds } })
        .populate('country', 'name').populate('region', 'name').populate('grapes', 'name').lean();
      const countries = {}, regions = {}, grapesMap = {};
      for (const wd of wds) {
        if (wd.country?.name && wd.country._id) countries[wd.country.name] = wd.country._id.toString();
        if (wd.region?.name && wd.region._id) regions[wd.region.name] = wd.region._id.toString();
        for (const g of (wd.grapes || [])) {
          if (g.name && g._id) grapesMap[g.name] = g._id.toString();
        }
      }
      facetMeta = { countries, regions, grapes: grapesMap };
    }

    const cellarObj = cellar.toObject();
    cellarObj.userRole = role;
    cellarObj.userColor = getUserColor(cellar, req.user.id);
    res.json({ cellar: cellarObj, bottles, facets, baseFacets, facetMeta });
  } catch (error) {
    console.error('Get cellar history error:', error);
    res.status(500).json({ error: 'Failed to get cellar history' });
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
      maturity: maturityFilter,
      sort = '-createdAt',
      exclude
    } = req.query;

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

    // Whether we need in-memory post-processing that neither Meilisearch nor MongoDB can do
    const needsMaturity = !!(maturityFilter || sortField === 'maturity');
    const MATURITY_RANK = { declining: 0, late: 1, peak: 2, early: 3, 'not-ready': 4 };

    // ── Determine if we can use Meilisearch as the primary search engine ──
    const hasMeiliFilters = !!(search || type || country || region || grapes || vintage || appellation);
    let usedMeili = false;
    let bottles;
    let totalCount;
    let canPaginateInDb;
    let groupsForPage = null;

    // ── HOT PATH: the default grouped cellar page (no filters, DB-sortable) ──
    // Group + paginate inside MongoDB instead of hydrating the whole cellar.
    const groupedInDb = grouped
      && !hasMeiliFilters
      && !minRating && !maxRating && !maturityFilter && !reservedOnly
      && ['createdAt', 'vintage', 'price', 'rating'].includes(sortField);
    if (groupedInDb) {
      ({ groupsForPage, bottles, totalCount } = await loadGroupedBottlePage({
        cellarId: req.params.id, excludeSet, sortField, sortDir, skip, limit,
      }));
      usedMeili = false;
      canPaginateInDb = false;
    }

    if (!groupedInDb && searchService.getIsAvailable() && hasMeiliFilters) {
      // ── PRIMARY PATH: Meilisearch handles search + filters ──
      try {
        const meiliResult = await searchService.searchBottles(search || '', {
          cellarId: req.params.id,
          type: type || undefined,
          countryId: country || undefined,
          regionId: region || undefined,
          appellation: appellation || undefined,
          grapeIds: grapeIds.length > 0 ? grapeIds : undefined,
          vintage: vintage || undefined,
          sort,
          limit: 10000,  // Get all matching IDs — we paginate after in-memory filters
          offset: 0
        });

        const matchingIds = meiliResult.ids;

        if (matchingIds.length === 0) {
          // Meilisearch found nothing — short-circuit
          return res.json({
            cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
            bottles: { count: 0, total: 0, limit, skip, grouped, items: [] },
            facets: meiliResult.facetDistribution || null,
            facetMeta: null
          });
        }

        // Exclude specific bottle IDs if requested
        let idsToFetch = matchingIds;
        if (excludeSet.size > 0) {
          idsToFetch = matchingIds.filter(id => !excludeSet.has(id));
        }

        // Fetch just the matching bottles from MongoDB (by ID) — much smaller query
        bottles = await Bottle.find({ _id: { $in: idsToFetch } })
          .populate(WINE_POPULATE_LIST)
          .lean();

        // Preserve Meilisearch's sort order
        const idOrder = new Map(idsToFetch.map((id, i) => [id, i]));
        bottles.sort((a, b) => (idOrder.get(a._id.toString()) ?? 0) - (idOrder.get(b._id.toString()) ?? 0));

        usedMeili = true;
        canPaginateInDb = false; // We paginate after in-memory filters below
      } catch {
        // Meilisearch failed — fall through to MongoDB path
      }
    }

    if (!usedMeili && !groupedInDb) {
      // ── FALLBACK PATH: MongoDB + in-memory (when Meilisearch unavailable) ──
      const filter = {
        cellar: req.params.id,
        status: { $nin: CONSUMED_STATUSES }
      };

      if (excludeSet.size > 0) {
        filter._id = { $nin: [...excludeSet] };
      }
      // Vintage: single or comma-separated
      if (vintage) {
        const vintages = String(vintage).split(',').map(v => v.trim()).filter(Boolean);
        filter.vintage = vintages.length === 1 ? vintages[0] : { $in: vintages };
      }

      // Taxonomy pre-query
      const wdFilter = {};
      if (country) {
        const countryIds = String(country).split(',').map(c => c.trim()).filter(isValidObjectId);
        if (countryIds.length === 1) wdFilter.country = countryIds[0];
        else if (countryIds.length > 1) wdFilter.country = { $in: countryIds };
      }
      if (region) {
        const regionIds = String(region).split(',').map(r => r.trim()).filter(isValidObjectId);
        if (regionIds.length === 1) wdFilter.region = regionIds[0];
        else if (regionIds.length > 1) wdFilter.region = { $in: regionIds };
      }
      if (type) {
        const types = String(type).split(',').map(t => t.trim()).filter(Boolean);
        wdFilter.type = types.length === 1 ? types[0] : { $in: types };
      }
      if (appellation) {
        const apps = String(appellation).split(',').map(a => a.trim()).filter(Boolean);
        if (apps.length > 0) wdFilter.appellation = apps.length === 1 ? apps[0] : { $in: apps };
      }
      if (grapeIds.length > 0) wdFilter.grapes = { $in: grapeIds };

      if (Object.keys(wdFilter).length > 0) {
        const matchingWdIds = await WineDefinition.find(wdFilter).distinct('_id');
        if (matchingWdIds.length === 0) {
          return res.json({
            cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
            bottles: { count: 0, total: 0, limit, skip, grouped, items: [] }
          });
        }
        filter.wineDefinition = { $in: matchingWdIds };
      }

      const directSortFields = ['createdAt', 'vintage', 'price', 'rating'];
      const canSortInDb_ = directSortFields.includes(sortField);
      const needsInMemoryFilter = !!(search || minRating || maxRating || maturityFilter || reservedOnly);
      const needsInMemorySort = !canSortInDb_;
      // Grouping needs every matching bottle in memory before it can collapse
      // duplicates, so it disables DB-level pagination.
      canPaginateInDb = !needsInMemoryFilter && !needsInMemorySort && !grouped;

      let query = Bottle.find(filter).populate(WINE_POPULATE_LIST);
      if (canSortInDb_) query = query.sort({ [sortField]: sortDir });
      if (canPaginateInDb) {
        query = query.skip(skip).limit(limit);
      } else {
        // Safety cap: an in-memory sort/group path must never hydrate an
        // unbounded populated set (a large cellar sorted by name/maturity would
        // otherwise load every active bottle into memory). Mirror the 10k cap
        // the sibling fallbacks use (bottles.js, cellars history, multi-cellar).
        query = query.limit(10000);
      }
      bottles = await query.lean();

      if (canPaginateInDb) {
        totalCount = await Bottle.countDocuments(filter);
      }

      // In-memory text search (fallback — no typo tolerance but multi-word AND works)
      if (search) {
        const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const words = stripAccents(search.toLowerCase()).split(/\s+/).filter(Boolean);
        bottles = bottles.filter(b => {
          const allText = [
            b.wineDefinition?.name,
            b.wineDefinition?.producer,
            b.notes,
            b.location,
            b.wineDefinition?.country?.name,
            b.wineDefinition?.region?.name,
            b.wineDefinition?.appellation,
            b.wineDefinition?.type,
            ...(b.wineDefinition?.grapes || []).map(g => g.name)
          ].filter(Boolean).map(s => stripAccents(s.toLowerCase())).join(' ');
          return words.every(word => allText.includes(word));
        });
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

    // ── Shared post-filters (applied to both Meilisearch and fallback paths) ──

    if (reservedOnly) {
      bottles = bottles.filter(isReserved);
    }

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
      if (maturityFilter === 'none') {
        bottles = bottles.filter(b => maturityStatusMap.get(b._id.toString()) == null);
      } else {
        bottles = bottles.filter(b => maturityStatusMap.get(b._id.toString()) === maturityFilter);
      }
    }

    // Meilisearch can't sort by maturity (it needs vintage profiles), so the
    // Meili path arrives here in relevance order — apply the maturity sort
    // in memory, mirroring the fallback path's comparator.
    if (sortField === 'maturity' && usedMeili && maturityStatusMap) {
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
    if (grouped && !groupsForPage) {
      const groupMap = new Map();
      const order = [];
      for (const b of bottles) {
        const wineId = b.wineDefinition?._id
          ? b.wineDefinition._id.toString()
          : (b.wineDefinition ? b.wineDefinition.toString() : `none:${b._id}`);
        // Group by wine + vintage + bottle size, so a magnum and a 750ml of the
        // same wine/vintage stay as separate groups.
        const key = `${wineId}::${b.vintage || 'NV'}::${b.bottleSize || '750ml'}`;
        let arr = groupMap.get(key);
        if (!arr) { arr = []; groupMap.set(key, arr); order.push(key); }
        arr.push(b);
      }
      totalCount = order.length;                      // total = number of groups
      const pageKeys = order.slice(skip, skip + limit);
      groupsForPage = pageKeys.map(key => ({ key, bottles: groupMap.get(key) }));
      bottles = groupsForPage.flatMap(g => g.bottles); // flatten so image attach below works
    } else if (!canPaginateInDb && !groupsForPage) {
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

    // ── Facets: two queries for smart cascading ──
    // 1. baseFacets: unfiltered — shows ALL options so users can always add more selections
    // 2. facets: filtered — reflects what's available given current filters (for counts + cascading)
    let facets = null;
    let baseFacets = null;
    let facetMeta = null;
    const hasAnyFilter = !!(type || country || region || grapes || vintage || appellation || search);
    if (searchService.getIsAvailable()) {
      try {
        // Always fetch unfiltered facets for showing all available options
        const baseResult = await searchService.searchBottles('', {
          cellarId: req.params.id,
          limit: 0, offset: 0
        });
        baseFacets = baseResult.facetDistribution || null;

        // If filters are active, also fetch filtered facets for cascading counts
        if (hasAnyFilter) {
          const filteredResult = await searchService.searchBottles(search || '', {
            cellarId: req.params.id,
            type: type || undefined,
            countryId: country || undefined,
            regionId: region || undefined,
            appellation: appellation || undefined,
            grapeIds: grapeIds.length > 0 ? grapeIds : undefined,
            vintage: vintage || undefined,
            limit: 0, offset: 0
          });
          facets = filteredResult.facetDistribution || null;
        } else {
          facets = baseFacets;
        }
      } catch {
        // Meilisearch unavailable — skip facets
      }
    }

    // Build name→ID mappings so the frontend can show names but filter by ID.
    // Query the distinct WineDefinitions for this cellar (fast: typically <200 unique wines).
    if (baseFacets || facets) {
      const wdIds = await Bottle.find({
        cellar: req.params.id,
        status: { $nin: CONSUMED_STATUSES }
      }).distinct('wineDefinition');

      const wds = await WineDefinition.find({ _id: { $in: wdIds } })
        .populate('country', 'name')
        .populate('region', 'name')
        .populate('grapes', 'name')
        .lean();

      const countries = {};
      const regions = {};
      const grapesMap = {};
      for (const wd of wds) {
        if (wd.country?.name && wd.country._id) {
          countries[wd.country.name] = wd.country._id.toString();
        }
        if (wd.region?.name && wd.region._id) {
          regions[wd.region.name] = wd.region._id.toString();
        }
        for (const g of (wd.grapes || [])) {
          if (g.name && g._id) grapesMap[g.name] = g._id.toString();
        }
      }
      facetMeta = { countries, regions, grapes: grapesMap };
    }

    res.json({
      cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
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

    const normalizedEmail = email.toLowerCase().trim();

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
        cellar.name,
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
    );

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
