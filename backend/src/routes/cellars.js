const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const Rack = require('../models/Rack');
const AuditLog = require('../models/AuditLog');
const WineRequest = require('../models/WineRequest');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { createCellar } = require('../services/rackOps');
const { listOpenBottles } = require('../services/openBottleList');
const { createNotification } = require('../services/notifications');
const { transferCellarOwnership } = require('../services/cellarTransfer');
const { filterByRating } = require('../utils/ratingUtils');
const {
  classifyMaturity, buildProfileMap, parseMaturityFilter, matchesMaturityFilter,
  buildMaturitySortKeys, compareMaturitySortKeys,
} = require('../utils/maturityUtils');
const { isReserved } = require('../utils/reservationUtils');
const {
  normalizeTaxonomyQuery, parseExtraBottleFilters, applyExtraBottleFilters, groupIdenticalBottles,
} = require('../utils/bottleListFilters');
const { CONSUMED_STATUSES, NOT_IN_CELLAR_STATUSES, ORDERED_STATUS, WINE_POPULATE_LIST, WINE_POPULATE_CARDS } = require('../config/constants');
const mongoose = require('mongoose');
const { parsePagination } = require('../utils/pagination');
const bottleSearch = require('../services/bottleSearch');
// A history's sections and paging; and a ranked page of bottles, loaded.
const { loadBottlesInOrder, countReasons, pageHistory, historyPaging } = require('../services/cellarHistory');
// The grouped page: its DB-side engine, and the name and quantity orders.
const {
  QUANTITY_SORT, byWineName, sortGroupsByQuantity, loadGroupedBottlePage,
} = require('../services/cellarGroupedPage');
// Bottles across several cellars at once: the cellars a user can read, the
// query over a set of them, and its facets.
const {
  resolveAccessibleCellars, queryBottlesAcrossCellars, facetsAcrossCellars,
} = require('../services/crossCellarQuery');
// A cellar in figures: its statistics and its bottles per maturity stage.
const { countMaturity, computeCellarStatistics } = require('../services/cellarStatistics');
const { getDataVersion, bumpDataVersion } = require('../services/dataVersion');
const { createTokenReadCache } = require('../services/tokenReadCache');

// The data version of a search scope's owners (services/dataVersion): the
// search keeps the scope's documents while it holds (services/bottleSearch),
// so typing and paging through one search load the cellar once.
const scopeVersion = (ownerIds) => [...new Set(ownerIds.map((id) => String(id && id._id ? id._id : id)))]
  .sort()
  .map((id) => `${id}:${getDataVersion(id)}`)
  .join(',');
const { isValidId, coerceStringQuery } = require('../utils/validation');
// Which picture each card of a bottle list shows.
const { attachBottleImageUrls } = require('../services/bottleImageUrls');

const router = express.Router();

// Resolve the requesting user's personal color preference for a cellar
function getUserColor(cellar, userId) {
  const entry = cellar.userColors?.find(uc => uc.user.toString() === userId.toString());
  return entry?.color || null;
}

// Machine polling (usage check 2026-10-09): the Home Assistant integration
// asks for the cellar list every few minutes per install, about 2,200 reads a
// day from some thirty installs, and it runs on about one active user in
// four. API-token requests are answered from memory while the user's data
// version (services/dataVersion) is unchanged — every audited cellar.* change
// moves the actor's and the owner's, and the membership routes move the
// member's, whose list changes without them acting. Browser reads are never
// cached.
const tokenListCache = createTokenReadCache();

// The people whose cellar list changes when this cellar changes hands, name
// or existence without them acting: its members. The actor and the owner are
// moved by the audit entry; these are the others.
function bumpMembers(cellar) {
  for (const m of cellar?.members || []) bumpDataVersion(m.user);
}

// All routes require authentication
router.use(requireAuth);

// GET /api/cellars - List user's cellars (owned + shared)
router.get('/', async (req, res) => {
  try {
    // Read the version BEFORE loading: a change landing during the load moves
    // it on, so the entry stored below can never outlive that change.
    const version = req.apiToken ? getDataVersion(req.user.id) : null;
    if (req.apiToken) {
      const hit = tokenListCache.get(req.user.id, 'list', version);
      if (hit) return res.json(hit);
    }

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

    const body = { count: cellarsWithRole.length, cellars: cellarsWithRole };
    if (req.apiToken) tokenListCache.set(req.user.id, 'list', version, body);
    res.json(body);
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
/**
 * The open bottles for the "Open now" strip (services/openBottleList), each
 * named with its cellar when several are in view. Auxiliary like the
 * on-order summary: a failed lookup shows no strip, never a failed list.
 */
async function openNowFor(cellarIds, cellarsById = null) {
  try {
    const rows = await listOpenBottles(cellarIds);
    if (!cellarsById) return rows;
    return rows.map((b) => ({ ...b, cellarName: cellarsById.get(String(b.cellar))?.name || null }));
  } catch (err) {
    console.warn('Open-now lookup failed (non-fatal):', err.message);
    return [];
  }
}

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
    // size) like the single-cellar view — chart deep links land here, and
    // identical bottles must not be listed one after another. Paginates over
    // groups, so it takes the whole
    // filtered set (the query's own 10k cap still bounds it).
    const grouped = req.query.group === '1' || req.query.group === 'true';
    const result = await queryBottlesAcrossCellars(req, {
      cellarIds, statusFilter: 'active', paginate: !grouped,
      version: scopeVersion(cellarIds.map(id => accessibleMap.get(id).user)),
    });
    const { limit, skip, maturityStatusMap, found, sortField, sortDir } = result;
    let { total } = result;
    let items = result.items;
    let groupsForPage = null;
    // Grouped, `total` counts cards; the filter's "Show n bottles" needs the
    // bottles behind them.
    let bottleTotal = null;
    if (grouped) {
      bottleTotal = items.length;
      const allGroups = groupIdenticalBottles(items, { byCellar: true });
      if (sortField === QUANTITY_SORT) sortGroupsByQuantity(allGroups, sortDir);
      total = allGroups.length;
      groupsForPage = allGroups.slice(skip, skip + limit);
      items = groupsForPage.flatMap(g => g.bottles);
    }
    // Facets only change the filter modal, which the client reads on the first
    // page only — skip counting them on every Load More.
    const { facets, baseFacets, facetMeta } = skip === 0
      ? await facetsAcrossCellars({ cellarIds, statusFilter: 'active', found })
      : { facets: null, baseFacets: null, facetMeta: null };
    // "Open now" above the list: first page only, each named with its cellar.
    const openBottles = skip === 0 ? await openNowFor(cellarIds, accessibleMap) : undefined;

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
      bottles: { count: items.length, total, limit, skip, grouped, items, ...(grouped ? { bottleTotal } : {}) },
      facets, baseFacets, facetMeta,
      ...(openBottles ? { openBottles } : {}),
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

// GET /api/cellars/:id/maturity-counts — how many bottles are at each stage,
// for the counts on the filter's maturity buttons. The filter asks as it
// opens; this groups only what the classification reads, not the cellar's
// other statistics (services/cellarStatistics).
router.get('/:id/maturity-counts', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findById(req.params.id);
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    res.json(await countMaturity(cellar._id));
  } catch (error) {
    console.error('Get maturity counts error:', error);
    res.status(500).json({ error: 'Failed to get maturity counts' });
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

    res.json({ statistics: await computeCellarStatistics(cellar._id, req.query.currency || null) });
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
// GET /api/cellars/:id/vintages/:wineId/:vintage — one wine and vintage in
// this cellar: the page behind a grouped "n identical bottles" entry.
// A VIEW over data that already exists, not a
// third storage level: the bottles with their rack slots and photos, what
// they share (a note or drink window identical on every one), how many are
// on order or already drunk, and a bottle id the page hands to the lot
// history and personal-data cards, which are keyed by bottle. Any member
// may look; drinking one needs editor, which the consume route enforces.
// The sommelier window and the registry's per-vintage values come from
// their own routes, as on the bottle page.
const VINTAGE_PAGE_LIMIT = 500;
const VINTAGE_SHARED_FIELDS = ['notes', 'drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil'];
const VINTAGE_PROFILE_SELECT = ['description', 'body', 'tannin', 'acidity', 'sweetness', 'flavors', 'foodPairings', 'source']
  .map((f) => `aiProfile.${f}`).join(' ');
router.get('/:id/vintages/:wineId/:vintage', async (req, res) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.wineId)) return res.status(400).json({ error: 'Invalid ID' });
    // Up to the 20 characters a bottle's vintage may hold: an imported
    // "Non-Vintage" is its own group, and its page link must find it.
    const vintageParam = String(req.params.vintage || '').trim().slice(0, 20);
    if (!vintageParam) return res.status(400).json({ error: 'Invalid vintage' });
    const cellar = await Cellar.findById(req.params.id).populate('user', 'username').lean();
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) return res.status(404).json({ error: 'Cellar not found' });

    // '' and null vintages read as NV in the grouped cellar view; match that
    // set (same rule as services/bottleLot).
    const vintageFilter = vintageParam === 'NV' ? { $in: ['NV', '', null] } : vintageParam;
    const base = { cellar: cellar._id, wineDefinition: req.params.wineId, vintage: vintageFilter };
    let bottles = await Bottle.find({ ...base, status: { $nin: NOT_IN_CELLAR_STATUSES } })
      .populate(WINE_POPULATE_CARDS)
      .sort({ addedToCellarAt: 1, createdAt: 1 })
      .limit(VINTAGE_PAGE_LIMIT)
      .lean();
    const [onOrderCount, consumedCount] = await Promise.all([
      Bottle.countDocuments({ ...base, status: ORDERED_STATUS }),
      Bottle.countDocuments({ ...base, status: { $in: CONSUMED_STATUSES } }),
    ]);
    // The wine as the cards carry it; from the last drunk bottle when nothing
    // is left (else one on order), so a vintage that is all history still has
    // a page.
    // The page reads the vintage's history and own data through one bottle:
    // one whose vintage is written out when there is one — an NV group also
    // holds imported bottles with an empty vintage, and "this vintage" own
    // data can only be scoped through a bottle that has one. The page is told
    // that bottle's vintage, so it offers the scope only when it can work.
    let wine = bottles[0]?.wineDefinition || null;
    const written = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const historyBottle = bottles.find((b) => written(b.vintage)) || bottles[0] || null;
    let historyBottleId = historyBottle?._id || null;
    let historyBottleVintage = written(historyBottle?.vintage);
    if (!wine) {
      const any = await Bottle.findOne({ ...base, status: { $in: CONSUMED_STATUSES } }).populate(WINE_POPULATE_CARDS).sort({ consumedAt: -1 }).lean()
        || await Bottle.findOne(base).populate(WINE_POPULATE_CARDS).sort({ createdAt: -1 }).lean();
      if (!any || !any.wineDefinition) return res.status(404).json({ error: 'No bottles of this wine and vintage here' });
      wine = any.wineDefinition;
      historyBottleId = any._id;
      historyBottleVintage = written(any.vintage);
    }

    // The tasting profile for the page's wine section. The cards leave the
    // prose out (WINE_LIST_SELECT), so it is read once here: the display
    // fields only, as the bottle page shows them. A held profile stores no
    // description and no descriptors, so it stays silent here too.
    try {
      const profiled = await WineDefinition.findById(wine._id).select(VINTAGE_PROFILE_SELECT).lean();
      wine = { ...wine, aiProfile: profiled?.aiProfile || null };
    } catch (err) {
      // Auxiliary, like the rack slots below: never 500 the page over it.
      console.error('Vintage page profile lookup failed:', err.message);
    }

    // Rack slots, answered here like the bottle page does: the page must not
    // download every rack to place a few bottles.
    const slotOf = {};
    // Said in the answer: when the lookup fails every bottle reads "not in a
    // rack", and the page must not take them for identical (DrinkOneModal).
    let placesKnown = true;
    if (bottles.length) {
      try {
        const ids = bottles.map((b) => b._id);
        const racks = await Rack.find({ cellar: cellar._id, deletedAt: null, 'slots.bottle': { $in: ids } })
          .select('name group slots').lean();
        const wanted = new Set(ids.map(String));
        let inRoomRacks = null;
        for (const rack of racks) {
          for (const slot of rack.slots || []) {
            const bid = slot.bottle && String(slot.bottle);
            if (!bid || !wanted.has(bid)) continue;
            if (inRoomRacks === null) {
              const CellarLayout = require('../models/CellarLayout');
              const layout = await CellarLayout.findOne({ cellar: cellar._id }).select('rackPlacements.rack').lean();
              inRoomRacks = new Set((layout?.rackPlacements || []).map((rp) => String(rp.rack?._id || rp.rack)));
            }
            slotOf[bid] = { rackId: rack._id, rackName: rack.name, rackGroup: rack.group || null, position: slot.position, inRoom: inRoomRacks.has(String(rack._id)) };
          }
        }
      } catch (err) {
        // Placement is auxiliary: never 500 the page over it.
        placesKnown = false;
        console.error('Vintage page rack lookup failed:', err.message);
      }
    }

    // Maturity as the cards show it (personal window over the shared profile).
    const profileMap = await buildProfileMap(bottles);
    bottles = await attachBottleImageUrls(bottles, req.user.id);
    bottles = bottles.map((b) => ({
      ...b,
      maturityStatus: classifyMaturity(b, profileMap),
      rackInfo: slotOf[String(b._id)] || null,
    }));

    // What every bottle in the cellar shares. A note identical on all of them
    // is shown once on the page; one that differs stays with its bottle.
    const shared = {};
    for (const field of VINTAGE_SHARED_FIELDS) {
      const values = new Set(bottles.map((b) => (b[field] == null || b[field] === '' ? null : b[field])));
      const only = values.size === 1 ? [...values][0] : undefined;
      shared[field] = bottles.length > 0 && only != null ? only : null;
    }

    res.json({
      cellar: { _id: cellar._id, name: cellar.name, userRole: role, userColor: getUserColor(cellar, req.user.id) },
      wine,
      vintage: vintageParam,
      bottles,
      total: bottles.length,
      onOrderCount,
      consumedCount,
      historyBottleId,
      historyBottleVintage,
      shared,
      placesKnown,
    });
  } catch (error) {
    console.error('Get vintage page error:', error);
    res.status(500).json({ error: 'Failed to get this vintage' });
  }
});

const ON_ORDER_LIMIT = 2000;
router.get('/:id/on-order', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const cellar = await Cellar.findById(req.params.id).populate('user', 'username').lean();
    const role = getCellarRole(cellar, req.user.id);
    if (!role || cellar.deletedAt) return res.status(404).json({ error: 'Cellar not found' });

    // Dated orders first (soonest first), then undated ones. Two queries,
    // because an ascending sort puts a missing date FIRST — and with the cap
    // that would cut dated orders rather than undated ones.
    const dated = await Bottle.find({ cellar: req.params.id, status: ORDERED_STATUS, expectedArrival: { $ne: null } })
      .populate(WINE_POPULATE_CARDS)
      .sort({ expectedArrival: 1, createdAt: 1 })
      .limit(ON_ORDER_LIMIT)
      .lean();
    const undated = dated.length < ON_ORDER_LIMIT
      ? await Bottle.find({ cellar: req.params.id, status: ORDERED_STATUS, expectedArrival: null })
        .populate(WINE_POPULATE_CARDS)
        .sort({ createdAt: 1 })
        .limit(ON_ORDER_LIMIT - dated.length)
        .lean()
      : [];
    const bottles = await attachBottleImageUrls([...dated, ...undated], req.user.id);

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

// The members of a cellar (list, add or invite, change a role, remove) have
// their own file; mounted here, after this router's auth.
router.use(require('./cellarMembers'));

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

    // Every value is one plain string or absent: a repeated parameter arrives
    // as an array and `?sort[$gt]=1` as an object, and neither may reach a
    // string method or a query.
    const one = (name) => coerceStringQuery(req.query[name]) || undefined;
    const country = one('country');
    const region = one('region');
    const grapes = one('grapes');
    const type = one('type');
    const vintage = one('vintage');
    const appellation = one('appellation');
    const minRating = one('minRating');
    const maxRating = one('maxRating');
    const ratingBandParam = one('ratingBand');
    const search = one('search');
    const sort = one('sort') || '-createdAt';
    const exclude = one('exclude');
    // null when absent; a Set of statuses otherwise (multi-select, OR-combined).
    const maturityFilter = parseMaturityFilter(coerceStringQuery(req.query.maturity));

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
    // or in any rack of that group ("what is in the basement"). Resolved to
    // an id set once and applied on every path like
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

    // ── Search: free text or a wine filter (type, country, region, appellation, grapes, vintage) ──
    const hasSearchFilters = !!(search || type || country || region || grapes || vintage || appellation);
    let found = null;
    let bottles;
    let totalCount;
    // Grouped: the bottles behind the `totalCount` cards.
    let bottleTotal = null;
    let canPaginateInDb;
    let groupsForPage = null;

    // ── HOT PATH: the default grouped cellar page (no filters, DB-sortable) ──
    // Group + paginate inside MongoDB instead of hydrating the whole cellar.
    const groupedInDb = grouped
      && !hasSearchFilters
      && !minRating && !maxRating && !ratingBandParam && !maturityFilter && !reservedOnly && !extraFilters
      && ['createdAt', 'vintage', 'price', 'rating', QUANTITY_SORT].includes(sortField);
    if (groupedInDb) {
      ({ groupsForPage, bottles, totalCount, bottleTotal } = await loadGroupedBottlePage({
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
      const pageOnly = !minRating && !maxRating && !ratingBandParam && !maturityFilter && !reservedOnly && !extraFilters
        && sortField !== 'maturity' && (sortField !== QUANTITY_SORT || grouped);
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
          // Cards holding as many keep the search's ranking.
          if (sortField === QUANTITY_SORT) sortGroupsByQuantity(allGroups, sortDir);
          totalCount = allGroups.length;
          bottleTotal = hits.length;
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
      const needsInMemoryFilter = !!(minRating || maxRating || ratingBandParam || maturityFilter || reservedOnly || extraFilters);
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

      // In-memory sort for fields that require populated data. Maturity sorts
      // after the shared post-filters below, on both paths.
      if (needsInMemorySort && sortField !== 'maturity') {
        bottles.sort((a, b) => {
          if (sortField === QUANTITY_SORT) return byWineName(a, b);
          if (sortField === 'name') return sortDir * byWineName(a, b);
          const aVal = a.createdAt;
          const bVal = b.createdAt;
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

    // A drunk bottle counts with the rating given when drinking (the history
    // list), and a band is exactly the statistics' band (utils/ratingUtils).
    bottles = filterByRating(bottles, { minRating, maxRating, ratingBand: ratingBandParam });

    let maturityStatusMap;
    let maturitySortKeys;
    if (needsMaturity) {
      const profileMap = await buildProfileMap(bottles);
      maturityStatusMap = new Map();
      for (const b of bottles) {
        maturityStatusMap.set(b._id.toString(), classifyMaturity(b, profileMap));
      }
      if (sortField === 'maturity') maturitySortKeys = buildMaturitySortKeys(bottles, profileMap, maturityStatusMap);
    }

    if (maturityFilter && maturityStatusMap) {
      bottles = bottles.filter(b => matchesMaturityFilter(maturityStatusMap.get(b._id.toString()), maturityFilter));
    }

    // Maturity needs the vintage profiles, so neither the search nor MongoDB
    // can order by it: both paths sort here (stage, then the year it ends).
    if (maturitySortKeys) {
      bottles.sort((a, b) => sortDir * compareMaturitySortKeys(
        maturitySortKeys.get(a._id.toString()), maturitySortKeys.get(b._id.toString())));
    }

    // Group identical bottles (same wine + vintage), or paginate normally.
    // `bottles` is fully filtered + sorted here; grouping preserves that order.
    // (Skipped when the DB-grouped hot path already produced groupsForPage.)
    if (grouped && !groupsForPage && !pageReady) {
      // Wine + vintage + bottle size, so a magnum and a 750ml stay apart.
      if (sortField === QUANTITY_SORT) bottles.sort(byWineName); // ties A to Z, also after a search
      const allGroups = groupIdenticalBottles(bottles);
      if (sortField === QUANTITY_SORT) sortGroupsByQuantity(allGroups, sortDir);
      totalCount = allGroups.length;                  // total = number of groups
      bottleTotal = bottles.length;                   // …and the bottles in them
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

    // "Open now" above the list (first page only).
    const openBottles = skip === 0 ? await openNowFor([cellar._id]) : undefined;

    res.json({
      cellar: { ...cellar, userRole: role, userColor: getUserColor(cellar, req.user.id) },
      onOrder: { count: onOrderCount, nextExpected },
      ...(openBottles ? { openBottles } : {}),
      bottles: {
        total: totalCount,
        count: responseItems.length,
        limit,
        skip,
        grouped,
        // Grouped, `total` counts cards; the filter's "Show n bottles" needs
        // the bottles behind them.
        ...(grouped ? { bottleTotal } : {}),
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
    if (name != null && typeof name !== 'string') return res.status(400).json({ error: 'name must be text' });
    if (description != null && typeof description !== 'string') return res.status(400).json({ error: 'description must be text' });

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
    bumpMembers(cellar);

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
    // Not audited (a personal preference), but userColor rides in the cached
    // token list of this user (release audit 2026-10-09, L).
    bumpDataVersion(req.user.id);
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
    bumpMembers(cellar);

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
    bumpDataVersion(newOwnerId);
    bumpMembers(result.cellar);

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
