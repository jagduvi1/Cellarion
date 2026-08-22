const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { requireBottleAccess } = require('../middleware/bottleAccess');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const { findVisibleWine } = require('../services/wineVisibility');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const WineVintageProfile = require('../models/WineVintageProfile');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const BottleImage = require('../models/BottleImage');
const WineRequest = require('../models/WineRequest');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getSnapshotForDate } = require('../utils/exchangeRates');
const { resolveRating } = require('../utils/ratingUtils');
const { CONSUMED_STATUSES, WINE_POPULATE, WINE_POPULATE_LIST } = require('../config/constants');
const { unlinkImageFiles } = require('../services/imageProcessor');
const { gatherPriceWarnings } = require('../services/priceWarnings');
const { getCurrentRelease } = require('../services/communityPrice');
const { stripHtml, escapeRegex } = require('../utils/sanitize');
const { toNormalized } = require('../utils/ratingUtils');
const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');
const { parsePagination } = require('../utils/pagination');
// Read-surface decoration: populated grapes gain `displayName` — the
// regionally correct label for the bottle's wine (Tinta Roriz on a Douro
// Port) — while `name` stays canonical for storage/filters/stats.
// resolveGrapeDisplayName feeds the in-memory search haystack below: what
// the card displays must be what search matches.
const { decorateGrapes, resolveGrapeDisplayName } = require('../utils/grapeDisplay');
const mongoose = require('mongoose');
const searchService = require('../services/search');
// add/update/consume/restore/remove logic + rack-slot freeing live in the
// shared service so the REST routes and the MCP tools can never drift (§7).
const {
  addBottle, validateBottleCommitFields, updateBottleFields, consumeBottle, restoreBottle, removeFromRacks, removeBottleCascade,
  openBottle, pourFromBottle, closeBottle,
} = require('../services/bottleOps');
// Mint-at-commit for the POST route's `newWine` branch — the wine is created
// (or resolved) INSIDE the bottle create, never before it. Shared with the
// wishlist route; findOrCreateWine itself is lazy-required inside the service.
const { resolveOrMintWine } = require('../services/wineCommit');
const { moveBottleToCellar } = require('../services/rackOps');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// GET /api/bottles — list the authenticated user's active bottles across all
// cellars they OWN (shared/read-only cellars are excluded, matching the
// Statistics page's scope so the deep-links from Statistics chart segments
// land on a bottle set with matching counts).
//
// Supported filter query params (all optional, combinable):
//   search       — free-text match against wine name / producer / notes / location / type / appellation / grape names
//   type         — wine type enum, comma-separated allowed
//   country      — country ID, comma-separated allowed
//   region       — region ID, comma-separated allowed
//   grapes       — grape ID, comma-separated
//   vintage      — vintage year string, comma-separated
//   producer     — exact producer string (case-insensitive)
//   bottleSize   — exact bottle-size string (e.g. "750ml")
//   minRating    — minimum normalised rating (0-100)
//   maturity     — one of 'declining','late','peak','early','not-ready','none'
//   sort         — 'createdAt'|'vintage'|'price'|'rating'|'name'|'maturity' with optional leading '-' for descending
//   limit / offset — pagination (defaults: limit 30, max 200)
router.get('/', async (req, res) => {
  try {
    const { isValidObjectId } = mongoose;

    const cellarIds = await Cellar.find({ user: req.user.id, deletedAt: null }).distinct('_id');
    const { limit, offset: skip } = parsePagination(req.query, { limit: 30, maxLimit: 200 });

    if (cellarIds.length === 0) {
      return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
    }

    // Defensive scalar coercion: Express's qs query parser turns inputs
    // like `?bottleSize[$ne]=1` into `{ bottleSize: { $ne: '1' } }`,
    // which would bypass per-field guards and leak Mongo operators into
    // the filter we build below. Reject anything that isn't a plain
    // string so every value below is guaranteed to be primitive.
    const q = (v) => (typeof v === 'string' ? v : undefined);
    const search           = q(req.query.search);
    const type             = q(req.query.type);
    const country          = q(req.query.country);
    const region           = q(req.query.region);
    const grapes           = q(req.query.grapes);
    const vintage          = q(req.query.vintage);
    const producer         = q(req.query.producer);
    const bottleSize       = q(req.query.bottleSize);
    const minRating        = q(req.query.minRating);
    const maturityFilter   = q(req.query.maturity);
    const sort             = q(req.query.sort) || '-createdAt';
    // Lifecycle filters — default is active-only, matching the
    // Statistics page's by-type / by-country / etc. aggregates.
    const statusFilter     = q(req.query.status);
    // Purchase / consumption year filters apply to bottle.purchaseDate
    // and bottle.consumedAt respectively — driven by the Statistics
    // page's Purchase History and Consumption History charts.
    const purchaseYear     = q(req.query.purchaseYear);
    const consumedYear     = q(req.query.consumedYear);

    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
    const sortDir = sort.startsWith('-') ? -1 : 1;

    const filter = {
      user: req.user.id,
      cellar: { $in: cellarIds },
    };

    // Status / lifecycle scope
    if (!statusFilter || statusFilter === 'active') {
      filter.status = { $nin: CONSUMED_STATUSES };
    } else if (statusFilter === 'all') {
      // no status constraint — include everything
    } else if (CONSUMED_STATUSES.includes(statusFilter)) {
      filter.status = statusFilter;
    } else if (statusFilter === 'consumed') {
      filter.status = { $in: CONSUMED_STATUSES };
    } else {
      // Unknown value — fall back to the default active scope
      filter.status = { $nin: CONSUMED_STATUSES };
    }

    if (vintage) {
      const vintages = String(vintage).split(',').map(v => v.trim()).filter(Boolean);
      filter.vintage = vintages.length === 1 ? vintages[0] : { $in: vintages };
    }

    if (bottleSize) {
      filter.bottleSize = String(bottleSize);
    }

    // Year-range filters on purchaseDate / consumedAt. Using $gte/$lt of
    // Jan 1 of the year and Jan 1 of next year lets MongoDB use the
    // existing date indexes and avoids JS-side getFullYear() iteration.
    const yearRange = (yearStr) => {
      const y = parseInt(yearStr, 10);
      if (isNaN(y) || y < 1900 || y > 2200) return null;
      return { $gte: new Date(y, 0, 1), $lt: new Date(y + 1, 0, 1) };
    };

    if (purchaseYear) {
      const range = yearRange(purchaseYear);
      if (range) filter.purchaseDate = range;
    }
    if (consumedYear) {
      const range = yearRange(consumedYear);
      if (range) filter.consumedAt = range;
    }

    // Pre-query WineDefinition for taxonomy / type / producer filters.
    // country/region values may be ObjectIds OR display names — the
    // Statistics charts only know names (the byCountry/byRegion stats
    // aggregate by name), so we resolve names to IDs on the fly here
    // so the same query param works from both worlds.
    const wdFilter = {};

    const resolveTaxonomy = async (raw, Model) => {
      const ids = [];
      const names = [];
      for (const v of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
        if (isValidObjectId(v)) ids.push(v);
        else names.push(v);
      }
      if (names.length > 0) {
        const found = await Model.find({ name: { $in: names } }).distinct('_id');
        ids.push(...found.map(id => id.toString()));
      }
      return ids;
    };

    if (country) {
      const ids = await resolveTaxonomy(country, Country);
      if (ids.length === 0) {
        return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
      }
      wdFilter.country = ids.length === 1 ? ids[0] : { $in: ids };
    }
    if (region) {
      const ids = await resolveTaxonomy(region, Region);
      if (ids.length === 0) {
        return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
      }
      wdFilter.region = ids.length === 1 ? ids[0] : { $in: ids };
    }
    // Grapes can also be passed as names (the byGrape stat is a name list)
    if (grapes) {
      const grapeIds2 = await resolveTaxonomy(grapes, Grape);
      if (grapeIds2.length === 0) {
        return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
      }
      wdFilter.grapes = grapeIds2.length === 1 ? grapeIds2[0] : { $in: grapeIds2 };
    }
    // 'unknown' is the stats bucket for bottles WITHOUT a wine definition
    // (typically pending wine requests from an import) — no WineDefinition
    // ever has that type, so it must match null-wineDefinition bottles
    // instead of going into the wd pre-query.
    let includeNoWine = false;
    if (type) {
      const types = String(type).split(',').map(t => t.trim()).filter(Boolean);
      includeNoWine = types.includes('unknown');
      const realTypes = types.filter(t => t !== 'unknown');
      if (realTypes.length > 0) {
        wdFilter.type = realTypes.length === 1 ? realTypes[0] : { $in: realTypes };
      }
    }
    if (producer) {
      // Producer is a free-text field on WineDefinition; match case-insensitively
      // with an anchored regex so chart segments that pass the exact value
      // (e.g. "Château Margaux") find that producer's bottles.
      const escaped = escapeRegex(producer);
      wdFilter.producer = new RegExp(`^${escaped}$`, 'i');
    }

    if (Object.keys(wdFilter).length > 0) {
      const wdIds = await WineDefinition.find(wdFilter).distinct('_id');
      if (wdIds.length === 0 && !includeNoWine) {
        return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
      }
      // $in with null matches bottles whose wineDefinition is null or absent.
      filter.wineDefinition = includeNoWine ? { $in: [...wdIds, null] } : { $in: wdIds };
    } else if (includeNoWine) {
      filter.wineDefinition = null;
    }

    const directSortFields = ['createdAt', 'vintage', 'price', 'rating'];
    const canSortInDb = directSortFields.includes(sortField);
    const needsInMemoryFilter = !!(search || minRating || maturityFilter);
    const canPaginateInDb = canSortInDb && !needsInMemoryFilter;

    let query = Bottle.find(filter).populate(WINE_POPULATE_LIST);
    if (canSortInDb) query = query.sort({ [sortField]: sortDir });
    if (canPaginateInDb) {
      query = query.skip(skip).limit(limit);
    } else {
      // Fallback (text search / min-rating / maturity filters, or in-memory
      // sorts) hydrates the set for in-memory processing — cap it like the
      // cellars.js fallbacks so one request can't load an unbounded
      // collection. When there's no DB sort to cap on, anchor on newest-added
      // so the >10k slice is at least deterministic.
      if (!canSortInDb) query = query.sort({ createdAt: -1 });
      query = query.limit(10000);
    }
    let bottles = await query.lean();
    let totalCount = canPaginateInDb ? await Bottle.countDocuments(filter) : null;

    // ── In-memory text search (multi-word AND across populated fields) ─────────
    if (search) {
      const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const words = stripAccents(String(search).toLowerCase()).split(/\s+/).filter(Boolean);
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
          // Canonical grape names PLUS the regional display name resolved for
          // this wine's own country/region when it differs ("Tinta Roriz" on
          // a Douro Port) — the card shows the regional label, so searching
          // it must hit (audit 2026-08-11). Undefineds fall to filter(Boolean).
          ...(b.wineDefinition?.grapes || []).flatMap(g => {
            const names = [g?.name];
            const display = resolveGrapeDisplayName(g, {
              countryId: b.wineDefinition.country,
              regionId: b.wineDefinition.region,
            });
            if (display && display !== g?.name) names.push(display);
            return names;
          }),
        ].filter(Boolean).map(s => stripAccents(String(s).toLowerCase())).join(' ');
        return words.every(word => allText.includes(word));
      });
    }

    // ── Min-rating post-filter (rating scales must be normalised) ──────────────
    if (minRating) {
      const min = parseFloat(minRating);
      if (!isNaN(min)) {
        bottles = bottles.filter(b => {
          if (b.rating == null) return false;
          return toNormalized(b.rating, b.ratingScale || '5') >= min;
        });
      }
    }

    // ── Maturity post-filter / sort (needs WineVintageProfile lookup) ─────────
    let maturityMap = null;
    const needsMaturity = !!(maturityFilter || sortField === 'maturity');
    if (needsMaturity) {
      const profileMap = await buildProfileMap(bottles);
      maturityMap = new Map();
      for (const b of bottles) {
        maturityMap.set(b._id.toString(), classifyMaturity(b, profileMap));
      }
    }

    if (maturityFilter && maturityMap) {
      if (maturityFilter === 'none') {
        bottles = bottles.filter(b => maturityMap.get(b._id.toString()) == null);
      } else {
        bottles = bottles.filter(b => maturityMap.get(b._id.toString()) === maturityFilter);
      }
    }

    // ── In-memory sort for fields we couldn't sort in the DB ──────────────────
    if (!canSortInDb) {
      const MATURITY_RANK = { declining: 0, late: 1, peak: 2, early: 3, 'not-ready': 4 };
      bottles.sort((a, b) => {
        let aVal, bVal;
        if (sortField === 'name') {
          aVal = a.wineDefinition?.name || '';
          bVal = b.wineDefinition?.name || '';
        } else if (sortField === 'maturity' && maturityMap) {
          const aStatus = maturityMap.get(a._id.toString());
          const bStatus = maturityMap.get(b._id.toString());
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

    if (!canPaginateInDb) {
      totalCount = bottles.length;
      bottles = bottles.slice(skip, skip + limit);
    }

    const items = bottles.map(b => ({
      ...b,
      // Regional grape display names resolved per wine (additive `displayName`
      // on each populated grape; canonical `name` untouched).
      ...(b.wineDefinition ? { wineDefinition: decorateGrapes(b.wineDefinition) } : {}),
      ...(maturityMap ? { maturityStatus: maturityMap.get(b._id.toString()) || null } : {}),
    }));

    res.json({
      bottles: {
        count: items.length,
        total: totalCount,
        limit,
        skip,
        items,
      },
    });
  } catch (err) {
    console.error('GET /api/bottles error:', err);
    res.status(500).json({ error: 'Failed to load bottles' });
  }
});

// POST /api/bottles - Add bottle to cellar (owner or editor).
// requireNonDemo: adding a bottle is intentionally NOT available in the demo.
// The real add-bottle experience leans on AI (label scan / identify), which is
// disabled for demo accounts, so rather than offer a lesser AI-free add we keep
// the demo an explore-and-interact experience on the pre-populated cellar
// (consume, pour, move, arrange, edit, browse). "Sign up to add your bottles."
//
// Wine reference — EXACTLY ONE of:
//   wineDefinition — id of an existing registry wine (the common case)
//   newWine        — { name, producer, country, region?, appellation?, type?,
//                      grapes?, confirmCreate?, source?, scanImageId?,
//                      scanImageBackId?, scanConflicts? }: mint-at-commit.
//                      The three scan fields are curation evidence for a
//                      pendingIdentity mint and are ignored otherwise — see
//                      services/wineCommit.
// The UI used to mint the WineDefinition in step 1 of the add flow (POST
// /api/wines/find-or-create), before any bottle existed — a user who abandoned
// the form left an orphan registry row forever. Measured on prod 2026-08-10:
// 31 zero-bottle createdVia:'ui' rows; one user minted "Domaine de Riquewihr —
// Kaefferkopf" (village-as-producer, likely fictitious) then attached their
// bottle to a different existing wine two minutes later. The wine is now
// resolved-or-minted HERE, inside the bottle create — the same commit-time
// pattern as import /confirm (#899) and the MCP add_bottle tool, via the same
// findOrCreateWine chokepoint (dedup, soft zone, taxonomy mint gates).
// Soft-zone: when very similar wines already exist, this returns 200
// { candidates } and creates NOTHING — the client re-submits with either an
// existing wineDefinition id or newWine + confirmCreate:true (identical
// semantics to the old find-or-create route, so the UI dialog is unchanged).
router.post('/', requireNonDemo, async (req, res) => {
  try {
    const { cellar, wineDefinition, newWine, price, currency } = req.body;

    if (!cellar || (!wineDefinition && !newWine)) {
      return res.status(400).json({ error: 'Cellar and a wine (wineDefinition or newWine) are required' });
    }
    if (wineDefinition && newWine) {
      return res.status(400).json({ error: 'Provide wineDefinition or newWine, not both' });
    }

    // Access + existence checks stay on the route — the shared service takes
    // ACCESS-CHECKED docs (same contract as the MCP tools). Soft-deleted
    // cellars are rejected too: a bottle added there would be invisible
    // everywhere (all cellar lists filter deletedAt) and effectively lost.
    // Cellar access is checked BEFORE any registry work, so a viewer (or a
    // stranger) can never mint a wine through a cellar they cannot add to.
    if (!mongoose.isValidObjectId(cellar)) {
      return res.status(400).json({ error: 'Invalid cellar ID' });
    }
    const cellarDoc = await Cellar.findById(cellar);
    if (!cellarDoc || cellarDoc.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    const role = getCellarRole(cellarDoc, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to add bottles to this cellar' });
    }

    let wineDoc;
    if (wineDefinition) {
      if (!mongoose.isValidObjectId(wineDefinition)) {
        return res.status(400).json({ error: 'Invalid wine definition ID' });
      }
      // Visible-to-this-user (services/wineVisibility). The CREATOR clause is
      // load-bearing here, not a nicety: a multi-bottle add posts bottles 2..N
      // against the wine id the first bottle minted, and that row is pending
      // precisely when the label could not be read. A blanket pending
      // exclusion would break the case the feature exists for; a stranger
      // still gets the same 404 a missing id gets.
      wineDoc = await findVisibleWine(wineDefinition, { userId: req.user.id, roles: req.user.roles });
      if (!wineDoc) {
        return res.status(404).json({ error: 'Wine definition not found' });
      }
    } else {
      // Commit-field validation BEFORE the mint (release-audit LOW-1): a
      // vintage/rating/notes 400 after resolveOrMintWine would leave the
      // exact orphan mint-at-commit exists to prevent. Checks-only — addBottle
      // still validates and resolves values itself below.
      const preCheck = validateBottleCommitFields(req.body);
      if (preCheck.error) {
        return res.status(preCheck.error.status).json({ error: preCheck.error.message });
      }
      // Mint-at-commit: validation caps, dedup/soft-zone, wine.create audit
      // (via 'ui'/'ai' per newWine.source) and IndexNow all live in the shared
      // service — one implementation with POST /api/wishlist's newWine branch.
      const minted = await resolveOrMintWine(newWine, req);
      if (minted.error) {
        return res.status(minted.error.status).json({ error: minted.error.message });
      }
      if (minted.candidates) {
        // Nothing was created — a multi-bottle client submit stops on the
        // FIRST bottle, so the whole batch waits on the user's answer.
        return res.status(200).json({ candidates: minted.candidates });
      }
      wineDoc = minted.wine;
    }

    // ONE shared implementation with the MCP add_bottle tool (plan §7):
    // validation, defaults, priceSetAt + FX snapshot, journey seed, migration
    // helpers (dateAdded / addToHistory), indexing, vintage-profile seed,
    // audit and the gated AI side effects all live in bottleOps.addBottle.
    const result = await addBottle(cellarDoc, wineDoc, req.body, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    const { bottle } = result;
    await bottle.populate(WINE_POPULATE);

    // Non-blocking sanity warnings on the entered price — a REST-only response
    // affordance (the add form highlights a likely mistake — 100×, cents-as-
    // units, etc. — without rejecting the save). See utils/priceValidation.
    let priceWarnings = [];
    if (typeof price === 'number' && price > 0) {
      try {
        priceWarnings = await gatherPriceWarnings({
          price,
          currency: currency || 'USD',
          userId: cellarDoc.user,
          // wineDoc, not the request field — on the newWine path there is no
          // wineDefinition id in the body.
          wineDefinitionId: wineDoc._id,
          vintage: bottle.vintage,
        });
      } catch (err) {
        console.warn('Price-warning gather failed (non-fatal):', err.message);
      }
    }

    res.status(201).json({ bottle, priceWarnings });
  } catch (error) {
    console.error('Create bottle error:', error);
    res.status(500).json({ error: 'Failed to create bottle' });
  }
});

// GET /api/bottles/:id - Get bottle details (owner, editor, or viewer of cellar)
router.get('/:id', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle, cellar, cellarRole: role } = req;
    await bottle.populate(WINE_POPULATE);

    // Join the historical rate snapshot for the date this price was entered.
    // Exposed as priceCurrencyRates so the frontend needs no changes.
    const bottleObj = bottle.toObject();
    // Regional grape display names resolved against the wine's own
    // country/region (additive `displayName`; canonical `name` untouched).
    if (bottleObj.wineDefinition) {
      bottleObj.wineDefinition = decorateGrapes(bottleObj.wineDefinition);
    }
    if (bottle.priceSetAt) {
      const date = bottle.priceSetAt.toISOString().slice(0, 10);
      const snapshot = await getSnapshotForDate(date);
      if (snapshot) bottleObj.priceCurrencyRates = snapshot.rates;
    }

    // Include the uploader's own pending image (pre-approval) so they see
    // it immediately on their bottle — other users see wine?.image after approval.
    // Bottles pending a wine request have no wineDefinition; that branch must be
    // omitted, or `{ wineDefinition: undefined }` matches every document and the
    // lookup returns a pending image from an unrelated bottle.
    const pendingImgOr = [{ bottle: bottle._id }];
    if (bottle.wineDefinition) {
      pendingImgOr.push({ wineDefinition: bottle.wineDefinition });
    }
    const pendingImg = await BottleImage.findOne({
      $or: pendingImgOr,
      uploadedBy: req.user.id,
      status: { $in: ['uploaded', 'processing', 'processed'] }
    }).sort({ createdAt: -1 }).lean();

    const pendingImageUrl = pendingImg
      ? (pendingImg.processedUrl || pendingImg.originalUrl)
      : null;

    // Resolve user's chosen default bottle image to a URL
    let defaultImageUrl = null;
    if (bottle.defaultImage) {
      const defaultImg = await BottleImage.findById(bottle.defaultImage).lean();
      if (defaultImg) {
        defaultImageUrl = defaultImg.processedUrl || defaultImg.originalUrl;
      }
    }

    // Community "current release" price for this wine in the bottle's currency —
    // the replacement-value signal for ordinary bottles. Null when there's no
    // community data in that currency yet. Never converted across currencies.
    let currentRelease = null;
    const wineId = bottle.wineDefinition && (bottle.wineDefinition._id || bottle.wineDefinition);
    if (wineId) {
      currentRelease = await getCurrentRelease(wineId, bottle.currency);
    }

    // Where this bottle sits, answered HERE rather than by the client
    // (2026-08-22, from the rate-limit analysis). BottleDetail used to
    // download EVERY rack with all slots plus the full 3D layout — two
    // requests and the two heaviest payloads on the page — and scan them in
    // the browser for one bottle id. `slots.bottle` carries a unique multikey
    // index, so the server answers with one indexed findOne and a few dozen
    // bytes. That per-open cost is what let an ordinary editing session hit
    // the API rate limit.
    let rackInfo = null;
    if (bottle.status === 'active') {
      // Own try/catch: placement is auxiliary, and its lookup failing must
      // degrade to "no rack shown", never 500 the bottle page.
      try {
        const Rack = require('../models/Rack');
        const rack = await Rack.findOne({
          cellar: cellar._id, 'slots.bottle': bottle._id, deletedAt: null,
        }).select('name slots').lean();
        if (rack) {
          const slot = rack.slots.find((s) => s.bottle && s.bottle.toString() === bottle._id.toString());
          // inRoom drives the "show me in the 3D room" affordance; one more
          // narrow query, and only when the bottle is actually racked.
          const CellarLayout = require('../models/CellarLayout');
          const layout = await CellarLayout.findOne({ cellar: cellar._id }).select('rackPlacements.rack').lean();
          const inRoom = !!layout?.rackPlacements?.some(
            (rp) => (rp.rack?._id || rp.rack)?.toString() === rack._id.toString()
          );
          rackInfo = { rackId: rack._id, rackName: rack.name, position: slot ? slot.position : null, inRoom };
        }
      } catch (err) {
        console.error('Bottle rackInfo lookup failed:', err.message);
      }
    }

    const ucEntry = cellar.userColors?.find(uc => uc.user.toString() === req.user.id.toString());
    res.json({ bottle: bottleObj, userRole: role, cellarColor: ucEntry?.color || null, pendingImageUrl, defaultImageUrl, currentRelease, rackInfo });
  } catch (error) {
    console.error('Get bottle error:', error);
    res.status(500).json({ error: 'Failed to get bottle' });
  }
});

// PUT /api/bottles/:id - Update bottle (owner or editor)
router.put('/:id', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;

    // ONE shared implementation with the MCP update_bottle tool (plan §7):
    // validation, vintage/size coercion, change detection, priceSetAt
    // anchoring, notifier-marker reset, re-index, vintage re-embed and the
    // { field: { from, to } } audit all live in bottleOps.updateBottleFields.
    // VersionError → 409 and ValidationError → 400 come back as { error }.
    const result = await updateBottleFields(bottle, req.body, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });

    await bottle.populate(WINE_POPULATE);
    res.json({ bottle });
  } catch (error) {
    console.error('Update bottle error:', error);
    res.status(500).json({ error: 'Failed to update bottle' });
  }
});

// PUT /api/bottles/:id/consumed-rating - Set or update rating on a consumed bottle
router.put('/:id/consumed-rating', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;
    if (!CONSUMED_STATUSES.includes(bottle.status)) {
      return res.status(400).json({ error: 'Bottle is not consumed' });
    }

    const { rating, ratingScale, note } = req.body;

    if (rating !== undefined) {
      const { rating: resolved, ratingScale: resolvedScale, error: ratingError } = resolveRating(rating, ratingScale);
      if (ratingError) return res.status(400).json({ error: ratingError });
      bottle.consumedRating = resolved;
      bottle.consumedRatingScale = resolvedScale;
    }

    if (note !== undefined) {
      if (note.length > 1000) return res.status(400).json({ error: 'Note is too long (max 1000 characters)' });
      bottle.consumedNote = stripHtml(note);
    }

    await bottle.save();
    await bottle.populate(WINE_POPULATE);

    logAudit(req, 'bottle.update',
      { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
      { changes: { consumedRating: rating, consumedNote: note !== undefined } }
    );

    res.json({ bottle });
  } catch (error) {
    console.error('Update consumed rating error:', error);
    res.status(500).json({ error: 'Failed to update consumed rating' });
  }
});

// PUT /api/bottles/:id/default-image - Set the user's preferred default image for this bottle
router.put('/:id/default-image', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;
    const { imageId } = req.body;

    if (!imageId) {
      // Clear default image
      bottle.defaultImage = null;
      await bottle.save();
      return res.json({ bottle });
    }

    // Cast the user-provided id to a real ObjectId before it touches the
    // query (a junk string would otherwise throw a CastError → 500; the cast
    // also clears the user-input-in-query taint for static analysis).
    if (!mongoose.isValidObjectId(imageId)) {
      return res.status(400).json({ error: 'Invalid image ID' });
    }
    const imageOid = new mongoose.Types.ObjectId(String(imageId));

    // Verify the image exists and belongs to this bottle or its wine
    // definition. Only add the wine clause when the bottle HAS a wine:
    // BottleImage.wineDefinition defaults to null, so for a pending-request
    // bottle (wineDefinition null) the clause would match ANY approved
    // unattached image in the DB. Also require public visibility, matching
    // the candidate list the UI offers (images.js /bottle/:bottleId).
    const orClauses = [{ bottle: bottle._id }];
    if (bottle.wineDefinition) {
      orClauses.push({ wineDefinition: bottle.wineDefinition, status: 'approved', visibility: 'public' });
    }
    const image = await BottleImage.findOne({ _id: imageOid, $or: orClauses });

    if (!image) {
      return res.status(404).json({ error: 'Image not found or not associated with this bottle' });
    }

    bottle.defaultImage = image._id;
    await bottle.save();
    await bottle.populate(WINE_POPULATE);

    res.json({ bottle });
  } catch (error) {
    console.error('Set default image error:', error);
    res.status(500).json({ error: 'Failed to set default image' });
  }
});

// POST /api/bottles/:id/consume - Soft-remove bottle (owner or editor)
router.post('/:id/consume', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { reason = 'drank', note, rating, consumedRatingScale } = req.body;
    const result = await consumeBottle(req.bottle, { reason, note, rating, ratingScale: consumedRatingScale }, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ bottle: result.bottle });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Consume bottle error:', error);
    res.status(500).json({ error: 'Failed to consume bottle' });
  }
});

// ── Open-bottle (Coravin / preservation) tracking ────────────────────────────
// The open/pour/close logic lives in services/bottleOps (shared with the MCP
// open_bottle / pour_glass / close_bottle tools), same as consume/restore.

// POST /api/bottles/:id/open — mark an active bottle as opened (owner or editor)
router.post('/:id/open', requireBottleAccess('editor'), async (req, res) => {
  try {
    const result = await openBottle(req.bottle, { preservationMethod: req.body?.preservationMethod }, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ bottle: result.bottle });
  } catch (error) {
    console.error('Open bottle error:', error);
    res.status(500).json({ error: 'Failed to open bottle' });
  }
});

// DELETE /api/bottles/:id/open — undo an accidental open (clears pours too)
router.delete('/:id/open', requireBottleAccess('editor'), async (req, res) => {
  try {
    const result = await closeBottle(req.bottle, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ bottle: result.bottle });
  } catch (error) {
    console.error('Undo open error:', error);
    res.status(500).json({ error: 'Failed to undo open' });
  }
});

// POST /api/bottles/:id/pour — record a pour (default: one 125 ml glass)
router.post('/:id/pour', requireBottleAccess('editor'), async (req, res) => {
  try {
    const result = await pourFromBottle(req.bottle, { ml: req.body?.ml }, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ bottle: result.bottle });
  } catch (error) {
    console.error('Pour error:', error);
    res.status(500).json({ error: 'Failed to record pour' });
  }
});

// DELETE /api/bottles/:id/pour — undo the most recent pour
router.delete('/:id/pour', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;
    // Same invariant closeBottle enforces: on a consumed bottle the pours are
    // preserved drinking history on the consumption record, not a live tally
    // (security audit 2026-07-30 M-1). This handler is inline rather than a
    // bottleOps call, so it needs its own copy of the guard.
    if (CONSUMED_STATUSES.includes(bottle.status)) {
      return res.status(409).json({
        error: 'This bottle was already consumed — its recorded pours are preserved drinking history. Restore the bottle first if the consume was a mistake.',
      });
    }
    if (!bottle.pours || bottle.pours.length === 0) {
      return res.status(400).json({ error: 'No pours to undo' });
    }
    bottle.pours.pop();
    await bottle.save();
    logAudit(req, 'bottle.pour_undo', { type: 'bottle', id: bottle._id, cellarId: bottle.cellar });
    res.json({ bottle });
  } catch (error) {
    console.error('Undo pour error:', error);
    res.status(500).json({ error: 'Failed to undo pour' });
  }
});

// POST /api/bottles/:id/move - Move an active bottle to another cellar you own.
// v1: own-cellars-only + active bottles only; the bottle lands UNPLACED in the
// destination (freed from any source rack slot). All bottle data is kept —
// createdAt (acquisition date) is preserved; addedToCellarAt + cellarHistory are
// updated. requireBottleAccess('owner') enforces you own the SOURCE cellar.
router.post('/:id/move', requireBottleAccess('owner'), async (req, res) => {
  try {
    const { bottle, cellar: sourceCellar } = req;
    const { toCellarId } = req.body;

    if (!toCellarId || !mongoose.isValidObjectId(toCellarId)) {
      return res.status(400).json({ error: 'Invalid destination cellar' });
    }
    if (String(toCellarId) === String(sourceCellar._id)) {
      return res.status(400).json({ error: 'Bottle is already in that cellar' });
    }
    if (bottle.status !== 'active') {
      return res.status(400).json({ error: 'Only active bottles can be moved' });
    }

    // Destination must be an active cellar the user OWNS (v1: own cellars only).
    // Cast the (already isValidObjectId-checked) id to an ObjectId so the query
    // value can never be a user-supplied operator object (defence-in-depth + keeps
    // static NoSQL-injection analysis happy).
    const destCellar = await Cellar.findOne({
      _id: new mongoose.Types.ObjectId(String(toCellarId)),
      user: req.user.id,
      deletedAt: null,
    });
    if (!destCellar) return res.status(404).json({ error: 'Destination cellar not found' });

    // Move mechanics (history seed, save-first ordering, unplace, dual audit)
    // are shared with the MCP move tool.
    const result = await moveBottleToCellar(bottle, sourceCellar, destCellar, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });

    await bottle.populate(WINE_POPULATE);
    res.json({ bottle });
  } catch (error) {
    console.error('Move bottle error:', error);
    res.status(500).json({ error: 'Failed to move bottle' });
  }
});

// A consumed bottle can be moved back to the cellar only within a 2-day
// window of being removed — restore is an "undo an accidental log", not a way
// to resurrect a bottle drunk long ago. The window (RESTORE_WINDOW_MS) is
// enforced inside services/bottleOps.restoreBottle, shared with the MCP tool.

// POST /api/bottles/:id/restore - Put a recently-consumed bottle back to active.
// The inverse of /consume: for when a bottle was marked drank/gifted/sold by
// mistake. Clears every consumed-* field so it re-enters the cellar cleanly.
// The bottle is NOT auto-returned to its old rack slot (the slot was freed on
// consume and may now be occupied) — it comes back unplaced, and the user
// re-racks it. Only allowed within RESTORE_WINDOW_MS of removal.
router.post('/:id/restore', requireBottleAccess('editor'), async (req, res) => {
  try {
    const result = await restoreBottle(req.bottle, req);
    if (result.error) {
      const { status, message, code } = result.error;
      return res.status(status).json({ error: message, ...(code ? { code } : {}) });
    }
    res.json({ bottle: result.bottle });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Restore bottle error:', error);
    res.status(500).json({ error: 'Failed to restore bottle' });
  }
});

// POST /api/bottles/:id/undo - Reverse an incorrectly-added bottle.
// The bottle disappears from cellar, racks, search, and stats as if it had
// never been added. Internal audit log keeps the original `bottle.add` row
// plus a new `bottle.undo` row so admins can still investigate disputes.
// Active bottles only — consumed bottles must use a different path.
router.post('/:id/undo', requireBottleAccess('editor'), async (req, res) => {
  try {
    // Full cleanup cascade shared with the MCP undo path (services/bottleOps).
    const result = await removeBottleCascade(req.bottle, req, 'bottle.undo');
    if (result.error) {
      return res.status(result.error.status).json({
        error: 'Only active bottles can be marked as a mistake. Already-consumed bottles cannot be undone.'
      });
    }
    res.json({ message: 'Bottle removed as mistake' });
  } catch (error) {
    console.error('Undo bottle error:', error);
    res.status(500).json({ error: 'Failed to undo bottle' });
  }
});

// DELETE /api/bottles/:id - Delete bottle (owner or editor)
// No frontend caller today (the UI uses consume + /undo), but API clients can
// reach it — so it runs the same image/wine-request cleanup as /undo instead
// of orphaning BottleImage docs and pending requests.
router.delete('/:id', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;
    const pendingRequestId = bottle.pendingWineRequest || null;

    // Remove bottle from any rack slot that references it
    await removeFromRacks(bottle._id);

    // Remove from Meilisearch before deleting
    searchService.removeBottle(bottle._id);

    const ownImages = await BottleImage.find({ bottle: bottle._id, assignedToWine: false })
      .select('originalUrl processedUrl').lean();
    for (const img of ownImages) await unlinkImageFiles(img);
    await BottleImage.deleteMany({ bottle: bottle._id, assignedToWine: false });
    await BottleImage.updateMany(
      { bottle: bottle._id, assignedToWine: true },
      { $set: { bottle: null } }
    );
    if (pendingRequestId) {
      await WineRequest.deleteOne({ _id: pendingRequestId, status: 'pending' });
    }

    logAudit(req, 'bottle.delete',
      { type: 'bottle', id: bottle._id, cellarId: bottle.cellar },
      {}
    );

    await bottle.deleteOne();
    res.json({ message: 'Bottle deleted successfully' });
  } catch (error) {
    console.error('Delete bottle error:', error);
    res.status(500).json({ error: 'Failed to delete bottle' });
  }
});

// POST /api/bottles/:id/request-price-tracking
// Opt this wine+vintage in to sommelier price tracking. Idempotent — re-posting
// from the same user updates their note + lastRequestedAt; the document is a
// singleton per (wineDefinition, vintage) so multiple requesters share it.
router.post('/:id/request-price-tracking', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle } = req;
    const userId = req.user.id;

    if (!bottle.wineDefinition || !bottle.vintage || bottle.vintage === 'NV' || bottle.vintage === 'Unknown') {
      return res.status(400).json({ error: 'This wine cannot be price-tracked (missing wine definition or vintage).' });
    }

    // A sommelier-declined pair stays declined: the decline flow (somm prices)
    // records a PriceTrackingSkip, and this check is what keeps the pair from
    // being re-queued. The decline reason is surfaced so the user learns WHY
    // instead of silently re-requesting into a void.
    const skip = await PriceTrackingSkip.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    }).lean();
    if (skip) {
      return res.status(409).json({
        error: skip.reason
          ? `A sommelier reviewed this wine and declined price tracking: ${skip.reason}`
          : 'A sommelier reviewed this wine and declined price tracking.'
      });
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : undefined;
    const now = new Date();

    // Find-or-create the singleton, then add/update this user in requesters.
    let request = await PriceTrackingRequest.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    });

    if (!request) {
      request = new PriceTrackingRequest({
        wineDefinition: bottle.wineDefinition,
        vintage: bottle.vintage,
        requesters: [{ user: userId, requestedAt: now, note }],
        firstRequestedAt: now,
        lastRequestedAt: now
      });
    } else {
      const existing = request.requesters.find(r => r.user.toString() === userId);
      if (existing) {
        existing.requestedAt = now;
        if (note !== undefined) existing.note = note;
      } else {
        request.requesters.push({ user: userId, requestedAt: now, note });
      }
      request.lastRequestedAt = now;
    }

    await request.save();

    logAudit(req, 'price.track_requested',
      { type: 'wineDefinition', id: bottle.wineDefinition },
      { vintage: bottle.vintage, bottleId: bottle._id }
    );

    res.json({
      requested: true,
      requesterCount: request.requesters.length,
      firstRequestedAt: request.firstRequestedAt
    });
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key — concurrent create raced. Retry once.
      return res.status(409).json({ error: 'Tracking request already exists — please retry.' });
    }
    console.error('Request price tracking error:', error);
    res.status(500).json({ error: 'Failed to request price tracking' });
  }
});

// DELETE /api/bottles/:id/request-price-tracking
// Cancel this user's request. If they were the only requester, the singleton
// is deleted entirely so the pair drops out of the somm queue.
router.delete('/:id/request-price-tracking', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle } = req;
    const userId = req.user.id;

    const request = await PriceTrackingRequest.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    });

    if (!request) {
      return res.json({ requested: false, requesterCount: 0 });
    }

    const before = request.requesters.length;
    request.requesters = request.requesters.filter(r => r.user.toString() !== userId);

    if (request.requesters.length === 0) {
      await request.deleteOne();
    } else if (request.requesters.length !== before) {
      await request.save();
    }

    logAudit(req, 'price.track_cancelled',
      { type: 'wineDefinition', id: bottle.wineDefinition },
      { vintage: bottle.vintage, bottleId: bottle._id }
    );

    res.json({ requested: false, requesterCount: request.requesters.length });
  } catch (error) {
    console.error('Cancel price tracking error:', error);
    res.status(500).json({ error: 'Failed to cancel price tracking' });
  }
});

// GET /api/bottles/:id/request-price-tracking
// Returns whether this user has an active request for this bottle's pair.
router.get('/:id/request-price-tracking', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle } = req;
    const userId = req.user.id;

    if (!bottle.wineDefinition || !bottle.vintage) {
      return res.json({ requested: false, requesterCount: 0, eligible: false });
    }
    const eligible = bottle.vintage !== 'NV' && bottle.vintage !== 'Unknown';
    if (!eligible) {
      return res.json({ requested: false, requesterCount: 0, eligible: false });
    }

    // Declined by a curator → reported as ineligible so the request toggle
    // disappears (POST would 409 anyway; don't invite a dead-end click).
    const skip = await PriceTrackingSkip.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    }).select('_id').lean();
    if (skip) {
      return res.json({ requested: false, requesterCount: 0, eligible: false, declined: true });
    }

    const request = await PriceTrackingRequest.findOne({
      wineDefinition: bottle.wineDefinition,
      vintage: bottle.vintage
    }).lean();

    if (!request) {
      return res.json({ requested: false, requesterCount: 0, eligible: true });
    }

    const mine = request.requesters.find(r => r.user.toString() === userId);
    res.json({
      requested: !!mine,
      requesterCount: request.requesters.length,
      firstRequestedAt: request.firstRequestedAt,
      eligible: true
    });
  } catch (error) {
    console.error('Get price tracking status error:', error);
    res.status(500).json({ error: 'Failed to get tracking status' });
  }
});

module.exports = router;
