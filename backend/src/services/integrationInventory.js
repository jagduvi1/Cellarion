/**
 * The inventory an integration reads (GET /api/inventory — contract in
 * docs/ha-push-events.md §4): every bottle still in the user's cellars, where
 * it is, what the wine is and when to drink it, in one compact document. The
 * Home Assistant integration polls it (conditionally — see inventoryTag) and
 * answers its own searches and cards from it.
 *
 * Scope is the offline snapshot's (services/offlineSnapshot): every
 * non-deleted cellar the user owns or is a member of, the bottles still in
 * them (status not in NOT_IN_CELLAR_STATUSES), their live racks. Nothing about
 * other users beyond what the cellar views already show — the username on a
 * personal-data entry, as on the bottle page.
 *
 * `include=consumed` widens the bottles to the ones that left those cellars
 * (drunk, gifted, sold, other) in the same shape, so a client keeps one
 * archive beside its stock (support ticket 2026-11-03). On-order bottles stay
 * out either way. The consumption record is loaded only when asked for.
 *
 * DATABASE READS ONLY. Nothing here, or reachable from here, may spend AI
 * money (Johan, 2026-10-21): no AI provider, no embedding, no label scan, no
 * semantic search, no enrichment, no Meilisearch. The tasting profile is the
 * stored one; when a wine has none, it has none.
 *
 * Lean by construction: every query projects only what the answer carries, so
 * the heavy bottle fields (cellarHistory, pours, barcode, purchase URLs …),
 * slot RFID tags and the registry's prose and bookkeeping are never even
 * loaded. Each wine is sent ONCE in `wines`; bottles reference it by id.
 */
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const { getCellarRole } = require('../utils/cellarAccess');
const { classifyMaturity, buildProfileMap, resolveEffectiveWindow } = require('../utils/maturityUtils');
const { decorateGrapes } = require('../utils/grapeDisplay');
const { slotLocation } = require('../utils/rackGeometry');
const { thumbPath } = require('../utils/thumbPath');
const { CONSUMED_STATUSES, NOT_IN_CELLAR_STATUSES } = require('../config/constants');
const { snapshotTag } = require('./offlineSnapshot');
const { listForBottles } = require('./personalData');

const INVENTORY_SCHEMA = 1;
// Salts the offline snapshot's validator: an inventory tag can never equal a
// snapshot tag, so neither document is ever answered 304 for the other.
const INVENTORY_TAG_SALT = 'inventory:1';
const PROFILE_LIST_MAX = 12;
// What ?include= may name. Each value adds bottles; none changes a field of a
// bottle that is still in the cellar.
const INCLUDE_VALUES = ['consumed'];
// The most bottles that left which one answer carries, newest first — the
// same cap as the app's own history list (routes/cellars). A stock is bounded
// by a cellar, a drinking history is not. The answer says how many there are
// and whether some were left out (consumedTotal / consumedTruncated); the
// number may change, so clients read the flag, never this constant.
const CONSUMED_LIMIT = 10000;

// What each query loads — and therefore all it CAN return.
const CELLAR_SELECT = 'name user members.user members.role';
const RACK_SELECT = 'cellar name type rows cols typeConfig isModular modules.type slots.position slots.bottle';
const BOTTLE_SELECT = [
  'cellar', 'wineDefinition', 'pendingWineRequest', 'status', 'vintage', 'bottleSize',
  'price', 'currency', 'rating', 'ratingScale', 'notes', 'purchaseDate', 'purchaseLocation',
  'createdAt', 'openedAt', 'location',
  // maturity + window (maturityUtils): the bottle's own window
  'drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil',
  // the card image (routes/cellars attachBottleImageUrls)
  'defaultImage',
].join(' ');
// The consumption record, added to the load only for include=consumed: the
// default build never reads a drinking note.
const CONSUMED_SELECT = 'consumedAt consumedNote consumedRating consumedRatingScale';
const INVENTORY_WINE_POPULATE = [
  {
    path: 'wineDefinition',
    select: 'name producer type colour nonWine country region appellation classification grapes image',
    populate: [
      { path: 'country', select: 'name' },
      { path: 'region', select: 'name' },
      // regionalNames: the display name on this wine's label (utils/grapeDisplay).
      { path: 'grapes', select: 'name regionalNames' },
    ],
  },
  { path: 'pendingWineRequest', select: 'wineName producer' },
];
// The descriptors only, plus what marks a held profile. Never the
// description, the confidence or any curation bookkeeping (producerSuspect,
// producerNote, heldReason, source, verifiedBy …).
const PROFILE_FIELDS = ['body', 'acidity', 'sweetness', 'tannin', 'flavors', 'foodPairings', 'heldAt'];
const PROFILE_SELECT = PROFILE_FIELDS.map((f) => `aiProfile.${f}`).join(' ');

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const year = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const iso = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/**
 * ?include= → { include: [known values] }, or { error } naming the first value
 * it does not know (a typo must not silently answer the default document).
 * Accepts a comma-separated list and repeated parameters.
 */
function parseInclude(raw) {
  const parts = [].concat(raw ?? [])
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : ['?']))
    .map((v) => v.trim())
    .filter(Boolean);
  const unknown = parts.find((v) => !INCLUDE_VALUES.includes(v));
  if (unknown !== undefined) {
    return { error: `Unknown include value "${unknown.slice(0, 40)}". Supported: ${INCLUDE_VALUES.join(', ')}.` };
  }
  return { include: [...new Set(parts)].sort() };
}

/**
 * The inventory's validator: the offline snapshot's, in its own tag space —
 * one per include set, since each answers a different document.
 */
function inventoryTag(userId, now = Date.now(), { include = [] } = {}) {
  const salt = include.length ? `${INVENTORY_TAG_SALT}:${include.join(',')}` : INVENTORY_TAG_SALT;
  return snapshotTag(userId, now, { salt });
}

/** A stored aiProfile → the contract's descriptors, or null (none, or held). */
function profileOf(ai) {
  if (!ai || ai.heldAt) return null;
  const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean).slice(0, PROFILE_LIST_MAX) : []);
  const p = {
    body: text(ai.body),
    acidity: text(ai.acidity),
    sweetness: text(ai.sweetness),
    tannin: text(ai.tannin),
    flavors: list(ai.flavors),
    foodPairings: list(ai.foodPairings),
  };
  const empty = !p.body && !p.acidity && !p.sweetness && !p.tannin && !p.flavors.length && !p.foodPairings.length;
  return empty ? null : p;
}

/** One wine as the contract sends it. `profile` comes from the separate profile read. */
function wineOf(wine, profile) {
  const w = decorateGrapes(wine);
  return {
    name: text(w.name),
    producer: text(w.producer),
    type: text(w.type),
    // 'other' = a drink that is not wine (cider, beer, spirits), outside the
    // shared wine registry; its type is then null.
    category: w.nonWine === true ? 'other' : 'wine',
    colour: text(w.colour),
    country: text(w.country && w.country.name),
    region: text(w.region && w.region.name),
    appellation: text(w.appellation),
    classification: text(w.classification),
    grapes: Array.isArray(w.grapes)
      ? w.grapes.map((g) => (g && typeof g === 'object' ? text(g.displayName) || text(g.name) : null)).filter(Boolean)
      : [],
    image: thumbPath(w.image),
    profile: profile || null,
  };
}

/**
 * The picture a bottle card shows, in BottleCard's order: chosen default →
 * the viewer's own photo of this bottle or vintage → the vintage's official
 * photo → the wine's registry image → the viewer's photo of another vintage.
 * An inline data: registry image counts as none, as in the offline copy.
 * Then as a thumbnail path, or null when it is not a photo on this instance.
 */
function bottleImageOf(b) {
  const registry = b.wineDefinition && typeof b.wineDefinition === 'object' ? b.wineDefinition.image : null;
  const usableRegistry = typeof registry === 'string' && !registry.startsWith('data:') ? registry : null;
  const src = b.defaultImageUrl || b.pendingImageUrl || b.vintageImageUrl || usableRegistry || b.otherVintageImageUrl || null;
  return thumbPath(src);
}

/** How a bottle that left the cellar was finished; the reason is its status. */
function consumedOf(b) {
  const rating = num(b.consumedRating);
  return {
    at: iso(b.consumedAt),
    rating,
    ratingScale: rating !== null ? text(b.consumedRatingScale) : null,
    note: text(b.consumedNote),
  };
}

function windowOf(b, profileMap) {
  const w = resolveEffectiveWindow(b, profileMap);
  return {
    drinkFrom: year(w && w.drinkFrom),
    peakFrom: year(w && w.peakFrom),
    peakUntil: year(w && w.peakUntil),
    drinkTo: year(w && w.drinkTo),
  };
}

/**
 * Pure: shape loaded documents into the inventory. Exported for tests.
 *  cellars   lean cellars (user, members, name)
 *  racks     lean racks (cellar, name, geometry, slots)
 *  bottles   lean, populated (INVENTORY_WINE_POPULATE) and carrying their
 *            image URLs (attachBottleImageUrls)
 *  profiles  Map wine id → aiProfile (the descriptors read)
 *  personal  Map bottle id → personal entries (personalData.listForBottles)
 *  profileMap  the reviewed drink-window profiles (maturityUtils.buildProfileMap)
 *  consumedSummary  { total, truncated } for include=consumed, else null
 */
function assembleInventory({
  userId, cellars, racks, bottles, profiles = new Map(), personal = new Map(), profileMap = new Map(), now = new Date(),
  consumedSummary = null,
}) {
  const cellarIds = new Set(cellars.map((c) => String(c._id)));

  const outRacks = [];
  const placeOf = new Map(); // bottle id → location
  for (const r of racks) {
    if (!cellarIds.has(idOf(r.cellar))) continue;
    outRacks.push({ id: String(r._id), cellar: idOf(r.cellar), name: text(r.name) });
    for (const s of r.slots || []) {
      const bid = idOf(s && s.bottle);
      if (!bid || placeOf.has(bid)) continue;
      const position = Number.isInteger(s.position) ? s.position : null;
      placeOf.set(bid, {
        rack: String(r._id),
        rackName: text(r.name),
        position,
        ...slotLocation(r, position),
      });
    }
  }

  const wines = {};
  const outBottles = [];
  for (const b of bottles) {
    const cellar = idOf(b.cellar);
    if (!cellarIds.has(cellar)) continue; // e.g. left behind by a soft-deleted cellar
    const wine = b.wineDefinition && typeof b.wineDefinition === 'object' && b.wineDefinition._id ? b.wineDefinition : null;
    const wineId = wine ? String(wine._id) : null;
    if (wineId && !wines[wineId]) wines[wineId] = wineOf(wine, profileOf(profiles.get(wineId)));
    const req = !wine && b.pendingWineRequest && typeof b.pendingWineRequest === 'object' ? b.pendingWineRequest : null;
    const id = String(b._id);
    const rating = num(b.rating);
    const purchased = iso(b.purchaseDate); // a picked day is stored as its UTC midnight
    // Only include=consumed loads bottles that left; a legacy row without a status is in the cellar.
    const left = CONSUMED_STATUSES.includes(b.status);
    outBottles.push({
      id,
      wine: wineId,
      pending: req ? { name: text(req.wineName), producer: text(req.producer) } : null,
      cellar,
      status: left ? b.status : 'active',
      vintage: text(b.vintage),
      size: text(b.bottleSize),
      price: num(b.price),
      currency: text(b.currency),
      rating,
      // A scale means something only beside a rating (the MCP get_bottle rule).
      ratingScale: rating !== null ? text(b.ratingScale) : null,
      notes: text(b.notes),
      purchaseDate: purchased ? purchased.slice(0, 10) : null,
      purchaseLocation: text(b.purchaseLocation),
      addedAt: iso(b.createdAt),
      opened: !!b.openedAt,
      consumed: left ? consumedOf(b) : null,
      // Today's place in the window means nothing for a bottle already finished.
      maturity: left ? null : classifyMaturity(b, profileMap) || null,
      window: windowOf(b, profileMap),
      location: placeOf.get(id) || null,
      place: text(b.location),
      image: bottleImageOf(b),
      personal: personal.get(id) || [],
    });
  }

  return {
    schema: INVENTORY_SCHEMA,
    generatedAt: now.toISOString(),
    cellars: cellars.map((c) => ({ id: String(c._id), name: text(c.name), role: getCellarRole(c, userId) })),
    racks: outRacks,
    wines,
    bottles: outBottles,
    // Only with include=consumed: how many bottles left, and whether this answer holds them all.
    ...(consumedSummary ? { consumedTotal: consumedSummary.total, consumedTruncated: consumedSummary.truncated } : {}),
  };
}

/** The stored tasting descriptors of these wines, in one query: Map wine id → aiProfile. */
async function loadProfiles(wineIds) {
  if (!wineIds.length) return new Map();
  const rows = await WineDefinition.find({ _id: { $in: wineIds } }).select(PROFILE_SELECT).lean();
  return new Map(rows.map((w) => [String(w._id), w.aiProfile || null]));
}

/**
 * Load and assemble one user's inventory. `attachBottleImageUrls` is the
 * cellar list's own image resolver (routes/cellars), passed in to avoid a
 * route→service require cycle, as the offline snapshot does. `include` is
 * parseInclude's list.
 */
async function buildInventory(userId, { attachBottleImageUrls, include = [] }) {
  const withConsumed = include.includes('consumed');
  const cellars = await Cellar.find({
    $or: [{ user: userId }, { 'members.user': userId }],
    deletedAt: null,
  })
    .select(CELLAR_SELECT)
    .sort({ createdAt: -1 })
    .lean();
  const ids = cellars.map((c) => c._id);
  const noneLeft = withConsumed ? { total: 0, truncated: false } : null;
  if (ids.length === 0) return assembleInventory({ userId, cellars, racks: [], bottles: [], consumedSummary: noneLeft });

  // The bottles that left: their own query, newest finished first, capped —
  // plus their count, so the answer can say when it holds fewer than all.
  const consumedFilter = { cellar: { $in: ids }, status: { $in: CONSUMED_STATUSES } };
  const [stock, racks, left, leftTotal] = await Promise.all([
    Bottle.find({ cellar: { $in: ids }, status: { $nin: NOT_IN_CELLAR_STATUSES } })
      .select(BOTTLE_SELECT)
      .populate(INVENTORY_WINE_POPULATE)
      .sort({ createdAt: -1 })
      .lean(),
    Rack.find({ cellar: { $in: ids }, deletedAt: null }).select(RACK_SELECT).sort({ createdAt: 1 }).lean(),
    withConsumed
      ? Bottle.find(consumedFilter)
        .select(`${BOTTLE_SELECT} ${CONSUMED_SELECT}`)
        .populate(INVENTORY_WINE_POPULATE)
        .sort({ consumedAt: -1, _id: -1 })
        .limit(CONSUMED_LIMIT)
        .lean()
      : [],
    withConsumed ? Bottle.countDocuments(consumedFilter) : 0,
  ]);
  const bottles = left.length ? [...stock, ...left] : stock;
  // Truncated only when the cap was reached: a bottle finished between the
  // two queries must not flag a complete answer as cut short.
  const consumedSummary = withConsumed
    ? { total: Math.max(leftTotal, left.length), truncated: left.length >= CONSUMED_LIMIT && leftTotal > left.length }
    : null;

  const wineIds = [...new Set(bottles.map((b) => idOf(b.wineDefinition)).filter(Boolean))];
  const [profiles, profileMap, personal, withImages] = await Promise.all([
    loadProfiles(wineIds),
    buildProfileMap(bottles),
    listForBottles(bottles, cellars),
    attachBottleImageUrls(bottles, userId),
  ]);

  return assembleInventory({ userId, cellars, racks, bottles: withImages, profiles, personal, profileMap, consumedSummary });
}

module.exports = {
  buildInventory,
  assembleInventory,
  inventoryTag,
  parseInclude,
  profileOf,
  INVENTORY_SCHEMA,
  INVENTORY_TAG_SALT,
  INCLUDE_VALUES,
  CONSUMED_LIMIT,
  INVENTORY_WINE_POPULATE,
  BOTTLE_SELECT,
  CONSUMED_SELECT,
  RACK_SELECT,
  CELLAR_SELECT,
  PROFILE_SELECT,
};
