const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const { requireBottleAccess } = require('../middleware/bottleAccess');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { findVisibleWine } = require('../services/wineVisibility');
const BottleImage = require('../models/BottleImage');
const { getCellarRole } = require('../utils/cellarAccess');
const { photoVintage, vintageKey } = require('../utils/imageVintage');
const { findVintageOfficials } = require('../services/vintageImages');
// The bottle page's own-photo pick reads a handful of the viewer's newest
// photos of the wine and chooses among them; it never needs them all.
const OWN_PHOTO_CANDIDATES = 50;
const { logAudit } = require('../services/audit');
const { getSnapshotForDate } = require('../utils/exchangeRates');
const { resolveRating } = require('../utils/ratingUtils');
const { CONSUMED_STATUSES, ORDERED_STATUS, WINE_POPULATE, WINE_POPULATE_KEEP_CREATOR } = require('../config/constants');
const { gatherPriceWarnings } = require('../services/priceWarnings');
const { getCurrentRelease } = require('../services/communityPrice');
const { findLotSiblingIds, findLotSiblings } = require('../services/bottleLot');
const { buildCaseJourneys } = require('../services/insightsService');
const { stripHtml } = require('../utils/sanitize');
const personalData = require('../services/personalData');
// Read-surface decoration: populated grapes gain `displayName` — the
// regionally correct label for the bottle's wine (Tinta Roriz on a Douro
// Port) — while `name` stays canonical for storage/filters/stats.
const { decorateGrapes } = require('../utils/grapeDisplay');
const mongoose = require('mongoose');
// add/update/consume/restore/remove logic + rack-slot freeing live in the
// shared service so the REST routes and the MCP tools can never drift (§7).
const {
  addBottle, validateBottleCommitFields, updateBottleFields, consumeBottle, restoreBottle, removeBottleCascade,
  openBottle, pourFromBottle, closeBottle, markArrived, changeBottleWine,
} = require('../services/bottleOps');
// Mint-at-commit for the POST route's `newWine` branch — the wine is created
// (or resolved) INSIDE the bottle create, never before it. Shared with the
// wishlist route; findOrCreateWine itself is lazy-required inside the service.
const { resolveOrMintWine } = require('../services/wineCommit');
const { applyOtherCategoryAfterAdd } = require('../services/nonWineOps');
const { moveBottleToCellar } = require('../services/rackOps');
const { getDataVersion } = require('../services/dataVersion');
const { TRASH_DAYS, trashBottle } = require('../services/bottleTrash');
const { queryUserBottles } = require('../services/bottleListQuery');
const { attachBottleImageUrls } = require('../services/bottleImageUrls');

const router = express.Router();

// Machine polling: Home Assistant asks `?maturity=…&limit=…` every few minutes
// and again after every change nudge, and the maturity path loads and
// classifies the whole collection per request (scaling audit 2026-09-25).
// API-token requests are answered from memory while the user's data version
// (services/dataVersion, moved by every audited bottle./cellar. change) is the
// one the answer was computed at; the max age bounds registry edits, curated
// drink windows, photos and anything else the version cannot see. Browser
// lists are never cached — they show fresh photos.
const tokenListCache = new Map(); // `${userId}|${query}` -> { at, version, body, bytes }
const TOKEN_LIST_MAX_AGE_MS = 30 * 60 * 1000;
const TOKEN_LIST_CACHE_MAX_ENTRIES = 2000;
// Bounded in bytes as well as entries: a big cellar's page is hundreds of KB,
// and 2,000 of those would be most of the process's memory (release audit
// 2026-09-27, L). One answer larger than the whole bound is not kept.
const TOKEN_LIST_CACHE_MAX_BYTES = 32 * 1024 * 1024;
let tokenListCacheBytes = 0;
// The params in a stable order, encoded so that no value can look like another
// key (`a=1&b=2` typed as one value used to read like two params) and so that a
// repeated param (?limit=10&limit=20 — parsePagination reads it) is part of the
// key instead of dropped. The handler ignores everything else.
const canonicalQuery = (query) => JSON.stringify(Object.keys(query).sort()
  .filter((k) => typeof query[k] === 'string' || Array.isArray(query[k]))
  .map((k) => [k, query[k]]));

// Custom fields accepted on one bottle create. The service enforces the real
// cap per target (personalData.ENTRIES_PER_TARGET); this only bounds the loop
// so a long array cannot turn one POST into unbounded work.
const MAX_CUSTOM_FIELDS = 20;

// All routes require authentication
router.use(requireAuth);
// Writes sent with an Idempotency-Key (the offline queue, #1355) apply at
// most once; without the header nothing changes.
router.use(idempotency);

// GET /api/bottles — the bottles in the cellars the user owns, narrowed, sorted
// and paged by the query parameters (services/bottleListQuery lists them).
router.get('/', async (req, res) => {
  try {
    // Version read BEFORE anything is loaded, so a change landing mid-compute
    // leaves the stored answer already out of date (see tokenListCache).
    const listCacheKey = req.apiToken ? `${req.user.id}|${canonicalQuery(req.query)}` : null;
    const listVersion = getDataVersion(req.user.id);
    if (listCacheKey) {
      const hit = tokenListCache.get(listCacheKey);
      if (hit && hit.version === listVersion && Date.now() - hit.at < TOKEN_LIST_MAX_AGE_MS) {
        return res.json(hit.body);
      }
    }

    const found = await queryUserBottles(req.user.id, req.query);
    const { limit, skip, maturityMap } = found;
    // No bottle was read (see queryUserBottles): answered as it is, never stored.
    if (found.nothingCanMatch) {
      return res.json({ bottles: { count: 0, total: 0, limit, skip, items: [] } });
    }
    let bottles = found.bottles;
    const totalCount = found.total;

    // The user's own photos (chosen default, own uploads by bottle or wine) —
    // the same resolution every cellar list uses. Without it this list shows
    // registry images only, so bottles photographed by their owner render
    // blank. A failed photo lookup degrades to registry images; it never
    // fails the list.
    try {
      bottles = await attachBottleImageUrls(bottles, req.user.id);
    } catch (err) {
      console.error('GET /api/bottles photo lookup failed:', err.message);
    }

    const items = bottles.map(b => ({
      ...b,
      // Regional grape display names resolved per wine (additive `displayName`
      // on each populated grape; canonical `name` untouched).
      ...(b.wineDefinition ? { wineDefinition: decorateGrapes(b.wineDefinition) } : {}),
      ...(maturityMap ? { maturityStatus: maturityMap.get(b._id.toString()) || null } : {}),
    }));

    const body = {
      bottles: {
        count: items.length,
        total: totalCount,
        limit,
        skip,
        items,
      },
    };
    if (listCacheKey) {
      const bytes = JSON.stringify(body).length;
      if (bytes <= TOKEN_LIST_CACHE_MAX_BYTES) {
        const previous = tokenListCache.get(listCacheKey);
        if (previous) tokenListCacheBytes -= previous.bytes;
        if (tokenListCache.size >= TOKEN_LIST_CACHE_MAX_ENTRIES || tokenListCacheBytes + bytes > TOKEN_LIST_CACHE_MAX_BYTES) {
          tokenListCache.clear();
          tokenListCacheBytes = 0;
        }
        tokenListCache.set(listCacheKey, { at: Date.now(), version: listVersion, body, bytes });
        tokenListCacheBytes += bytes;
      }
    }
    res.json(body);
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
    const { cellar, wineDefinition, newWine, price, personalData: customFields } = req.body;

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
    // The Other category on a record the registry already had as wine: the
    // member now holds a bottle of it, so their word applies (few holders)
    // or files for a curator, exactly as from the bottle page. Before the
    // populate, so the answer shows the row as it now is.
    const notWine = newWine
      ? await applyOtherCategoryAfterAdd({ wine: wineDoc, newWine, userId: req.user.id, req, via: 'add' })
      : null;
    await bottle.populate(WINE_POPULATE);

    // Custom fields typed in the add form (e.g. an ABV entered while adding
    // the bottle). Same typed key/value data the bottle page writes,
    // through the same service, so the two surfaces cannot drift; the add form
    // is only a second entry point to it.
    //
    // NOT fatal: the bottle exists by now, so a rejected field cannot undo it
    // and a 400 here would be a lie. Each failure is reported back the way
    // priceWarnings are, and the form shows them without losing the add.
    const customFieldErrors = [];
    if (Array.isArray(customFields) && customFields.length > 0) {
      // Say what was dropped. A silent truncation is the one failure mode the
      // caller cannot see: the bottle is 201 and the field simply is not there.
      // One line for all of them: echoing one per dropped element let a 64 kB
      // body come back as ~1.5 MB of repeats (release audit 2026-09-27, L).
      if (customFields.length > MAX_CUSTOM_FIELDS) {
        const dropped = customFields.length - MAX_CUSTOM_FIELDS;
        customFieldErrors.push({
          key: null,
          error: `Too many custom fields in one add (max ${MAX_CUSTOM_FIELDS}) — ${dropped} not saved`,
        });
      }
      for (const field of customFields.slice(0, MAX_CUSTOM_FIELDS)) {
        const spec = {
          level: field?.level === 'wine' ? 'wine' : 'bottle',
          keyId: field?.keyId,
          newKey: field?.newKey,
          value: field?.value,
          vintageScoped: field?.vintageScoped === true,
        };
        try {
          // dedupe: an N-bottle add posts the same WINE-level field once per
          // bottle (they share one wine record), and a retry after a partial
          // failure re-posts what the first attempt already wrote.
          const entryRes = await personalData.createEntry(req.user.id, bottle, spec, { dedupe: true });
          if (!entryRes.ok) {
            customFieldErrors.push({ key: spec.newKey?.name || null, error: entryRes.message });
            continue;
          }
          if (entryRes.deduped) continue;
          logAudit(
            req,
            'personal_data.entry_create',
            { type: spec.level, id: entryRes.entry._id, cellarId: cellarDoc._id },
            { key: entryRes.entry.key.name, keyCreated: entryRes.keyCreated, via: 'add-bottle' }
          );
        } catch (err) {
          console.warn('Custom field on bottle create failed (non-fatal):', err.message);
          customFieldErrors.push({ key: spec.newKey?.name || null, error: 'Could not be saved' });
        }
      }
    }

    // Non-blocking sanity warnings on the entered price — a REST-only response
    // affordance (the add form highlights a likely mistake — 100×, cents-as-
    // units, etc. — without rejecting the save). See utils/priceValidation.
    let priceWarnings = [];
    if (typeof price === 'number' && price > 0) {
      try {
        priceWarnings = await gatherPriceWarnings({
          price,
          currency: bottle.currency || 'USD', // as stored (an alias mapped)
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

    res.status(201).json({
      bottle,
      priceWarnings,
      ...(notWine ? { notWine } : {}),
      ...(customFieldErrors.length > 0 ? { customFieldErrors } : {}),
    });
  } catch (error) {
    console.error('Create bottle error:', error);
    res.status(500).json({ error: 'Failed to create bottle' });
  }
});

// A cellar's "Recently deleted" and the bulk actions have their own file.
// Mounted here, behind this router's auth and idempotency and BEFORE the
// /:id routes: Express would otherwise read "trash" as a bottle id.
router.use(require('./bottlesBulk'));

// GET /api/bottles/:id - Get bottle details (owner, editor, or viewer of cellar)
router.get('/:id', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle, cellar, cellarRole: role } = req;
    await bottle.populate(WINE_POPULATE_KEEP_CREATOR);

    // Join the historical rate snapshot for the date this price was entered.
    // Exposed as priceCurrencyRates so the frontend needs no changes.
    const bottleObj = bottle.toObject();
    // Regional grape display names resolved against the wine's own
    // country/region (additive `displayName`; canonical `name` untouched).
    if (bottleObj.wineDefinition) {
      bottleObj.wineDefinition = decorateGrapes(bottleObj.wineDefinition);
      // A private draft wine (models/WineDefinition.draft): tell the page
      // whose it is as a boolean — the client cannot compute that itself,
      // list payloads strip createdBy — and when its clock lapses.
      if (bottleObj.wineDefinition.draft === true) {
        bottleObj.wineDraft = {
          mine: String(bottleObj.wineDefinition.createdBy) === String(req.user.id),
          expiresAt: bottleObj.wineDefinition.draftExpiresAt || null,
        };
      }
      // Loaded for the line above only; who contributed a wine is not sent.
      delete bottleObj.wineDefinition.createdBy;
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
    // Each sibling's vintage: a photo pinned to a sibling is a photo of THAT
    // bottle's vintage even before the row carries its own tag.
    const vintageOfSibling = new Map();
    if (bottle.wineDefinition) {
      pendingImgOr.push({ wineDefinition: bottle.wineDefinition });
      // The viewer's other bottles of the same wine: a photo uploaded while a
      // bottle still waited for its wine request carries no wineDefinition,
      // so only its bottle knows the wine (the same rule as the cellar list's
      // attachBottleImageUrls).
      try {
        const siblings = await Bottle.find({ user: req.user.id, wineDefinition: bottle.wineDefinition, _id: { $ne: bottle._id } }).select('_id vintage').lean();
        for (const s of siblings) vintageOfSibling.set(String(s._id), photoVintage(s.vintage));
        if (siblings.length) pendingImgOr.push({ bottle: { $in: siblings.map((s) => s._id) } });
      } catch (err) {
        // A photo nicety must never take the bottle page down.
        console.error('Sibling photo lookup failed:', err.message);
      }
    }
    const ownPhotos = await BottleImage.find({
      $or: pendingImgOr,
      uploadedBy: req.user.id,
      // Pending OR approved — the uploader's own photo must not vanish from
      // the hero the moment it is approved (same rule as the cellar list,
      // discussion #1227).
      status: { $in: ['uploaded', 'processing', 'processed', 'approved'] },
      // Never a label scan — same rule as the cellar list (routes/cellars.js
      // attachBottleImageUrls): the scanner's raw
      // frame is private curation evidence, not a bottle photo.
      kind: { $ne: 'label-scan' },
    }).sort({ createdAt: -1 }).limit(OWN_PHOTO_CANDIDATES).lean();
    // Same order as the cellar list (routes/cellars.js attachBottleImageUrls),
    // so the card and the page agree: this
    // bottle's own photo, else the viewer's photo of the same vintage, else
    // the vintage's official photo, else the wine's registry image (client),
    // and only then the viewer's photo of another vintage.
    const thisVintage = photoVintage(bottle.vintage);
    const vintageOfPhoto = (img) => photoVintage(img.vintage) || (img.bottle ? vintageOfSibling.get(String(img.bottle)) : null) || null;
    const pendingImg = ownPhotos.find((img) => img.bottle && String(img.bottle) === String(bottle._id))
      || (thisVintage ? ownPhotos.find((img) => vintageOfPhoto(img) === thisVintage) : null)
      || null;
    const otherVintageImg = pendingImg ? null : (ownPhotos[0] || null);

    const pendingImageUrl = pendingImg
      ? (pendingImg.processedUrl || pendingImg.originalUrl)
      : null;
    const otherVintageImageUrl = otherVintageImg
      ? (otherVintageImg.processedUrl || otherVintageImg.originalUrl)
      : null;

    // The vintage's official photo: the first one of this wine AND vintage
    // an admin approved (or the one they chose), by anyone, with its credit.
    let vintageImageUrl = null;
    let vintageImageCredit = null;
    if (bottle.wineDefinition && thisVintage) {
      try {
        const wineIdStr = String(bottle.wineDefinition._id || bottle.wineDefinition);
        const official = (await findVintageOfficials([wineIdStr], [thisVintage])).get(vintageKey(wineIdStr, thisVintage));
        if (official) {
          vintageImageUrl = official.url;
          vintageImageCredit = official.credit;
        }
      } catch (err) {
        console.error('Vintage photo lookup failed:', err.message);
      }
    }

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

    // Where this bottle sits, answered HERE rather than by the client: for
    // BottleDetail to download EVERY rack with all slots plus the full 3D
    // layout — two requests and the two heaviest payloads on the page — and
    // scan them in the browser for one bottle id costs enough per open to let
    // an ordinary editing session hit the API rate limit. `slots.bottle`
    // carries a unique multikey index, so the server answers with one indexed
    // findOne and a few dozen bytes.
    let rackInfo = null;
    // Whether the cellar has any rack at all: the page offers "Place in a
    // rack" on an unplaced bottle only where that can lead somewhere.
    // One indexed existence check, and only
    // when the bottle is not racked (a racked bottle proves it).
    let cellarHasRacks = false;
    if (bottle.status === 'active') {
      // Own try/catch: placement is auxiliary, and its lookup failing must
      // degrade to "no rack shown", never 500 the bottle page.
      try {
        const Rack = require('../models/Rack');
        const rack = await Rack.findOne({
          cellar: cellar._id, 'slots.bottle': bottle._id, deletedAt: null,
        }).select('name slots').lean();
        if (!rack) {
          cellarHasRacks = !!(await Rack.exists({ cellar: cellar._id, deletedAt: null }));
        }
        if (rack) {
          cellarHasRacks = true;
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

    // The other active bottles of this wine and vintage in the viewer's OWN
    // cellars, so the edit form can offer "also apply the drink window and
    // price to the other N". Auxiliary: a lookup
    // failure degrades to "no checkbox", never a 500.
    // Only from a bottle in the viewer's OWN cellar: the lot is the viewer's
    // bottles, which from someone else's cellar would be the wrong lot.
    let lotSiblingIds = [];
    if (String(cellar.user && (cellar.user._id || cellar.user)) === String(req.user.id)) {
      try {
        lotSiblingIds = await findLotSiblingIds(req.user.id, bottle);
      } catch (err) {
        console.error('Lot sibling lookup failed:', err.message);
      }
    }

    const ucEntry = cellar.userColors?.find(uc => uc.user.toString() === req.user.id.toString());
    res.json({ bottle: bottleObj, userRole: role, cellarColor: ucEntry?.color || null, pendingImageUrl, defaultImageUrl, vintageImageUrl, vintageImageCredit, otherVintageImageUrl, currentRelease, rackInfo, cellarHasRacks, lotSiblingIds });
  } catch (error) {
    console.error('Get bottle error:', error);
    res.status(500).json({ error: 'Failed to get bottle' });
  }
});

// The viewer's OWN story with this wine: what happened to their other bottles
// of it — how many remain, and for each one already drunk the date, rating and
// note. The data is always stored — a consumed bottle keeps its document —
// but without this only the drunk bottle's own page shows it.
//
// NOTHING IS COPIED BETWEEN BOTTLES. This is computed on read from the
// siblings, so each bottle stays the single truth about itself; storing it in
// every bottle would duplicate data and make a later correction silently
// wrong on every other copy.
//
// ?vintages=this (default) is the bottle's own vintage, 'all' every vintage of
// the wine as its own group, newest first — your note on the 2019 next to the
// 2020 you are holding (mirrors the Reviews card's "this vintage / all
// vintages" filter on the same page). Vintages are never merged: a rating of
// the 2015 says nothing about whether the 2020 is ready, and the drink window
// and pace verdict are per vintage.
//
// Owned cellars only, exactly like the lot above: from a bottle in someone
// else's cellar the viewer's own bottles would be the wrong story to tell.
const LOT_HISTORY_MAX_VINTAGES = 20;
router.get('/:id/lot-history', requireBottleAccess('viewer'), async (req, res) => {
  try {
    const { bottle, cellar } = req;
    const scope = req.query.vintages === 'all' ? 'all' : 'this';
    const empty = { scope, vintage: bottle.vintage || 'NV', lots: [] };

    const ownsCellar = String(cellar.user && (cellar.user._id || cellar.user)) === String(req.user.id);
    // A bottle still waiting for its wine request has no registry wine, and
    // the lot is defined by that wine — there is nothing to group by yet.
    if (!ownsCellar || !bottle.wineDefinition) return res.json(empty);

    const result = await buildCaseJourneys(req.user.id, {
      focusWineId: String(bottle.wineDefinition._id || bottle.wineDefinition),
      focusVintage: scope === 'all' ? null : (bottle.vintage || 'NV'),
      sort: 'vintage',
      limit: scope === 'all' ? LOT_HISTORY_MAX_VINTAGES : 1,
      // The bottle on screen must be among the capped vintages, or a
      // 21-vintage vertical's oldest bottle reads "no bottles of this vintage".
      pinVintage: scope === 'all' ? (bottle.vintage || 'NV') : null,
      // The page shows a note as the user wrote it (the field allows 1000).
      noteMaxLength: 1000,
      // The vintage page links each other vintage to ITS vintage page, which
      // lives under a cellar — the lot says which cellars hold it.
      withCellars: true,
    });
    res.json({ ...empty, lots: result.data || [] });
  } catch (error) {
    console.error('Lot history error:', error);
    res.status(500).json({ error: 'Failed to load this wine\'s history' });
  }
});

// PUT /api/bottles/:id - Update bottle (owner or editor)
router.put('/:id', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { bottle } = req;

    // ifUnchanged (offline queue, #1355): the values of notes / rating /
    // ratingScale the user saw when they edited offline. A field someone else
    // has changed since — and not to the same new value — is a conflict: 409
    // with the current values, so the user chooses instead of one edit
    // silently overwriting the other. Absent → not checked (live clients).
    const { ifUnchanged } = req.body || {};
    if (ifUnchanged !== undefined) {
      delete req.body.ifUnchanged;
      if (ifUnchanged && typeof ifUnchanged === 'object') {
        const same = (a, b) => (a ?? null) === (b ?? null);
        const conflicts = ['notes', 'rating', 'ratingScale'].filter((k) => k in ifUnchanged
          && !same(bottle[k], ifUnchanged[k]) && !same(bottle[k], req.body[k]));
        if (conflicts.length) {
          const current = Object.fromEntries(conflicts.map((k) => [k, bottle[k] ?? null]));
          return res.status(409).json({ error: 'Changed elsewhere since your edit', code: 'field_changed', current });
        }
      }
    }

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
      // null clears the note; anything else has to be text.
      if (note !== null && typeof note !== 'string') return res.status(400).json({ error: 'Note must be text' });
      if (note !== null && note.length > 1000) return res.status(400).json({ error: 'Note is too long (max 1000 characters)' });
      bottle.consumedNote = note === null ? '' : stripHtml(note);
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

    // Shared with the MCP set_bottle_default_image tool (services/imageOps):
    // the candidate rule, the id cast, the clear-on-empty and the audit row
    // live there once.
    // Lazy: imageOps pulls in the image pipeline, which this route needs only here.
    const { setBottleDefaultImage } = require('../services/imageOps');
    const result = await setBottleDefaultImage(bottle, imageId, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    if (!imageId) return res.json({ bottle });

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
    // consumedAt: the day the bottle was actually drunk, when that is not
    // today. The service validates it (a real date, not in the future);
    // absent → now. The bulk action takes the same field.
    const { reason = 'drank', note, rating, consumedRatingScale, consumedAt, ifActive } = req.body;
    // ifActive (offline queue, #1355): only consume a bottle still in the
    // cellar — one consumed elsewhere meanwhile must not have its record
    // overwritten by a queued consume. Absent → unchanged behaviour.
    if (ifActive === true && req.bottle.status !== 'active') {
      return res.status(409).json({ error: 'This bottle has already left the cellar', code: 'state_changed' });
    }
    const result = await consumeBottle(req.bottle, { reason, note, rating, ratingScale: consumedRatingScale, consumedAt }, req);
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

// POST /api/bottles/:id/change-wine — move a saved bottle to another registry
// wine (owner or editor): { wineDefinitionId, applyToLot? }. The bottle keeps
// all its own data (services/bottleOps.changeBottleWine). applyToLot also
// moves the other bottles of the same wine and vintage in the caller's OWN
// cellars (services/bottleLot — the "also apply to the other N" lot), found
// BEFORE the move so they are the old wine's lot.
router.post('/:id/change-wine', requireBottleAccess('editor'), async (req, res) => {
  try {
    const { wineDefinitionId, applyToLot } = req.body || {};
    if (!mongoose.isValidObjectId(wineDefinitionId)) {
      return res.status(400).json({ error: 'A valid wineDefinitionId is required' });
    }
    // The same visibility rule as adding a bottle: someone else's pending or
    // private draft wine is reported as not found.
    const wineDoc = await findVisibleWine(String(wineDefinitionId), { userId: req.user.id, roles: req.user.roles });
    if (!wineDoc) return res.status(404).json({ error: 'Wine not found' });

    const siblings = applyToLot === true ? await findLotSiblings(req.user.id, req.bottle) : [];
    const result = await changeBottleWine(req.bottle, wineDoc, req);
    if (result.error) {
      const { status, message, code } = result.error;
      return res.status(status).json({ error: message, ...(code ? { code } : {}) });
    }
    let alsoMoved = 0;
    for (const sibling of siblings) {
      const r = await changeBottleWine(sibling, wineDoc, req);
      if (!r.error) alsoMoved += 1;
    }
    await result.bottle.populate(WINE_POPULATE);
    res.json({ bottle: result.bottle, alsoMoved });
  } catch (error) {
    console.error('Change wine error:', error);
    res.status(500).json({ error: 'Failed to change the wine' });
  }
});

// POST /api/bottles/:id/arrive — a bottle on order has been delivered (owner
// or editor). It becomes active and lands unplaced; body.arrivedAt is an
// optional day, default today. Many at once: POST /bulk { action: 'arrive' }.
router.post('/:id/arrive', requireBottleAccess('editor'), async (req, res) => {
  try {
    const result = await markArrived(req.bottle, { arrivedAt: req.body?.arrivedAt }, req);
    if (result.error) {
      const { status, message, code } = result.error;
      return res.status(status).json({ error: message, ...(code ? { code } : {}) });
    }
    res.json({ bottle: result.bottle });
  } catch (error) {
    console.error('Mark arrived error:', error);
    res.status(500).json({ error: 'Failed to mark the bottle as arrived' });
  }
});

// ── Open-bottle (Coravin / preservation) tracking ────────────────────────────
// The open/pour/close logic lives in services/bottleOps (shared with the MCP
// open_bottle / pour_glass / close_bottle tools), same as consume/restore.

// POST /api/bottles/:id/open — mark an active bottle as opened (owner or editor)
router.post('/:id/open', requireBottleAccess('editor'), async (req, res) => {
  try {
    // openedAt: when it was really opened — an open queued offline (#1355) is
    // sent later. Validated by the service (not future, at most 90 days back).
    // takeOutOfRack: the bottle leaves its slot (on the counter, not back in
    // the rack); takenOutOf names the slot it left, null when it stayed.
    const result = await openBottle(req.bottle, {
      preservationMethod: req.body?.preservationMethod,
      openedAt: req.body?.openedAt,
      takeOutOfRack: req.body?.takeOutOfRack,
    }, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ bottle: result.bottle, takenOutOf: result.takenOutOf });
  } catch (error) {
    console.error('Open bottle error:', error);
    res.status(500).json({ error: 'Failed to open bottle' });
  }
});

// DELETE /api/bottles/:id/open — undo an accidental open (clears pours too).
// A bottle taken out of its rack when opened goes back into that slot while
// it is free; putBack names the slot, null when it stays unplaced.
router.delete('/:id/open', requireBottleAccess('editor'), async (req, res) => {
  try {
    const result = await closeBottle(req.bottle, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ bottle: result.bottle, putBack: result.putBack });
  } catch (error) {
    console.error('Undo open error:', error);
    res.status(500).json({ error: 'Failed to undo open' });
  }
});

// POST /api/bottles/:id/pour — record a pour (default: one 125 ml glass)
router.post('/:id/pour', requireBottleAccess('editor'), async (req, res) => {
  try {
    // expectPours: the pours the user saw, sent by the offline queue — 409
    // state_changed when the bottle has more or fewer by now (services/bottleOps).
    const result = await pourFromBottle(req.bottle, { ml: req.body?.ml, expectPours: req.body?.expectPours }, req);
    if (result.error) {
      const { status, message, code } = result.error;
      return res.status(status).json({ error: message, ...(code ? { code } : {}) });
    }
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
    // Two undos at once: the second save finds the pours changed under it.
    if (error.name === 'VersionError') {
      return res.status(409).json({ error: 'This bottle was modified by another request. Please refresh and try again.' });
    }
    console.error('Undo pour error:', error);
    res.status(500).json({ error: 'Failed to undo pour' });
  }
});

// POST /api/bottles/:id/move - Move an active bottle to another cellar you own.
// v1: own-cellars-only + active (or on-order) bottles only; it lands UNPLACED in the
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
    if (bottle.status !== 'active' && bottle.status !== ORDERED_STATUS) {
      return res.status(400).json({ error: 'Only bottles in the cellar or on order can be moved' });
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
// never been added — into the cellar's "Recently deleted" for TRASH_DAYS, like
// any delete in the app (services/bottleTrash), so a slip on "Added by
// mistake?" can be undone. It used to be gone for good. The audit log keeps the
// original `bottle.add` row plus a `bottle.undo` row so admins can still tell
// a mistaken add from a deletion. Active (or on-order) bottles only — consumed
// bottles must use a different path. The MCP undo tools call the service
// layer directly and are unchanged.
// Response: { message, batchId, purgeAt } — batchId restores it (POST /trash/restore).
router.post('/:id/undo', requireBottleAccess('editor'), async (req, res) => {
  try {
    if (req.bottle.status !== 'active' && req.bottle.status !== ORDERED_STATUS) {
      return res.status(400).json({
        error: 'Only active bottles can be marked as a mistake. Already-consumed bottles cannot be undone.'
      });
    }
    const batchId = new mongoose.Types.ObjectId();
    const deletedAt = new Date();
    const result = await trashBottle(req.bottle, req, { batchId, deletedAt, auditAction: 'bottle.undo' });
    if (result.error) {
      return res.status(result.error.status || 400).json({
        error: 'Only active bottles can be marked as a mistake. Already-consumed bottles cannot be undone.'
      });
    }
    res.json({
      message: 'Bottle removed as mistake',
      batchId,
      purgeAt: new Date(deletedAt.getTime() + TRASH_DAYS * 24 * 60 * 60 * 1000),
    });
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
    // The shared cascade (services/bottleOps.removeBottleCascade), the same
    // one MCP delete_bottle runs, for a bottle of any status: rack slot
    // freed, the user's own photos deleted with their files, registry photos
    // (the wine's picture, or any photo approved as public) kept and
    // detached, the import request withdrawn only when THIS was the last
    // bottle waiting on it, and the audit written after the delete so the
    // data version moves once the bottle is really gone.
    const result = await removeBottleCascade(req.bottle, req, 'bottle.delete', { anyStatus: true, auditDetail: {} });
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    res.json({ message: 'Bottle deleted successfully' });
  } catch (error) {
    console.error('Delete bottle error:', error);
    res.status(500).json({ error: 'Failed to delete bottle' });
  }
});

// The price-tracking opt-in of a bottle has its own file. Mounted here, behind
// this router's auth and idempotency.
router.use(require('./bottlePriceTracking'));

module.exports = router;
