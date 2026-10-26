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
const { NOT_IN_CELLAR_STATUSES } = require('../config/constants');
const { snapshotTag } = require('./offlineSnapshot');
const { listForBottles } = require('./personalData');

const INVENTORY_SCHEMA = 1;
// Salts the offline snapshot's validator: an inventory tag can never equal a
// snapshot tag, so neither document is ever answered 304 for the other.
const INVENTORY_TAG_SALT = 'inventory:1';
const PROFILE_LIST_MAX = 12;

// What each query loads — and therefore all it CAN return.
const CELLAR_SELECT = 'name user members.user members.role';
const RACK_SELECT = 'cellar name type rows cols typeConfig isModular modules.type slots.position slots.bottle';
const BOTTLE_SELECT = [
  'cellar', 'wineDefinition', 'pendingWineRequest', 'vintage', 'bottleSize',
  'price', 'currency', 'rating', 'ratingScale', 'notes', 'purchaseDate', 'purchaseLocation',
  'createdAt', 'openedAt', 'location',
  // maturity + window (maturityUtils): the bottle's own window
  'drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil',
  // the card image (routes/cellars attachBottleImageUrls)
  'defaultImage',
].join(' ');
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

/** The inventory's validator: the offline snapshot's, in its own tag space. */
function inventoryTag(userId, now = Date.now()) {
  return snapshotTag(userId, now, { salt: INVENTORY_TAG_SALT });
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
 */
function assembleInventory({
  userId, cellars, racks, bottles, profiles = new Map(), personal = new Map(), profileMap = new Map(), now = new Date(),
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
    outBottles.push({
      id,
      wine: wineId,
      pending: req ? { name: text(req.wineName), producer: text(req.producer) } : null,
      cellar,
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
      maturity: classifyMaturity(b, profileMap) || null,
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
 * route→service require cycle, as the offline snapshot does.
 */
async function buildInventory(userId, { attachBottleImageUrls }) {
  const cellars = await Cellar.find({
    $or: [{ user: userId }, { 'members.user': userId }],
    deletedAt: null,
  })
    .select(CELLAR_SELECT)
    .sort({ createdAt: -1 })
    .lean();
  const ids = cellars.map((c) => c._id);
  if (ids.length === 0) return assembleInventory({ userId, cellars, racks: [], bottles: [] });

  const [bottles, racks] = await Promise.all([
    Bottle.find({ cellar: { $in: ids }, status: { $nin: NOT_IN_CELLAR_STATUSES } })
      .select(BOTTLE_SELECT)
      .populate(INVENTORY_WINE_POPULATE)
      .sort({ createdAt: -1 })
      .lean(),
    Rack.find({ cellar: { $in: ids }, deletedAt: null }).select(RACK_SELECT).sort({ createdAt: 1 }).lean(),
  ]);

  const wineIds = [...new Set(bottles.map((b) => idOf(b.wineDefinition)).filter(Boolean))];
  const [profiles, profileMap, personal, withImages] = await Promise.all([
    loadProfiles(wineIds),
    buildProfileMap(bottles),
    listForBottles(bottles, cellars),
    attachBottleImageUrls(bottles, userId),
  ]);

  return assembleInventory({ userId, cellars, racks, bottles: withImages, profiles, personal, profileMap });
}

module.exports = {
  buildInventory,
  assembleInventory,
  inventoryTag,
  profileOf,
  INVENTORY_SCHEMA,
  INVENTORY_TAG_SALT,
  INVENTORY_WINE_POPULATE,
  BOTTLE_SELECT,
  RACK_SELECT,
  CELLAR_SELECT,
  PROFILE_SELECT,
};
