/**
 * Offline snapshot (#1355): everything the app needs to show a user's cellars,
 * racks and bottles with no network — one compact document the client keeps
 * on the device and answers its own reads from while offline.
 *
 * Scope: every non-deleted cellar the user owns or is a member of (shared
 * cellars included, with the user's role), the bottles still in them, and
 * their racks. Nothing else: no history, no registry beyond the wines those
 * bottles reference, no other users' data beyond what the cellar views already
 * return (member ids, the owner's username).
 *
 * Each wine is sent ONCE in `wines`; bottles and rack slots reference it by id
 * and the client joins them back (six bottles of a wine used to mean six copies
 * of its registry record). Bottles carry exactly what the cellar list gives
 * them: the list-weight wine populate, their resolved card image, and their
 * maturity status.
 */
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const { getCellarRole } = require('../utils/cellarAccess');
const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');
const { CONSUMED_STATUSES, WINE_POPULATE_LIST } = require('../config/constants');

const SNAPSHOT_SCHEMA = 1;

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

function userColorOf(cellar, userId) {
  const entry = cellar.userColors?.find((uc) => String(uc.user) === String(userId));
  return entry?.color || null;
}

/**
 * Pure: shape loaded documents into the snapshot. Exported for tests.
 * `bottles` are populated (wineDefinition as an object) and already carry
 * their image URLs; `maturity` maps bottle id → status.
 */
function assembleSnapshot({ userId, cellars, bottles, racks, maturity = new Map(), now = new Date() }) {
  const cellarIds = new Set(cellars.map((c) => String(c._id)));
  const wines = {};
  const outBottles = [];
  for (const b of bottles) {
    if (!cellarIds.has(idOf(b.cellar))) continue; // e.g. left behind by a soft-deleted cellar
    const wine = b.wineDefinition && typeof b.wineDefinition === 'object' ? b.wineDefinition : null;
    if (wine && wine._id) wines[String(wine._id)] = wine;
    outBottles.push({
      ...b,
      wineDefinition: wine ? String(wine._id) : idOf(b.wineDefinition),
      maturityStatus: maturity.get(String(b._id)) || null,
    });
  }
  const bottleIds = new Set(outBottles.map((b) => String(b._id)));
  const outRacks = racks
    .filter((r) => cellarIds.has(idOf(r.cellar)))
    .map((r) => ({
      ...r,
      slots: (r.slots || []).map((s) => ({
        ...s,
        // Only bottles in the snapshot; a dangling reference would render as
        // an unknown bottle offline.
        bottle: s.bottle && bottleIds.has(idOf(s.bottle)) ? idOf(s.bottle) : null,
      })),
    }));
  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: now.toISOString(),
    userId: String(userId),
    cellars: cellars.map((c) => ({ ...c, userRole: getCellarRole(c, userId), userColor: userColorOf(c, userId) })),
    wines,
    bottles: outBottles,
    racks: outRacks,
  };
}

/**
 * Load and assemble the snapshot for one user. `attachBottleImageUrls` is the
 * cellar list's own resolver (routes/cellars), passed in to avoid a
 * route→service require cycle.
 */
async function buildOfflineSnapshot(userId, { attachBottleImageUrls }) {
  const cellars = await Cellar.find({
    $or: [{ user: userId }, { 'members.user': userId }],
    deletedAt: null,
  })
    .populate('user', 'username')
    .sort({ createdAt: -1 })
    .lean();
  const ids = cellars.map((c) => c._id);

  const bottles = ids.length
    ? await Bottle.find({ cellar: { $in: ids }, status: { $nin: CONSUMED_STATUSES } })
      .populate(WINE_POPULATE_LIST)
      .lean()
    : [];
  const racks = ids.length
    ? await Rack.find({ cellar: { $in: ids }, deletedAt: null }).lean()
    : [];

  const profileMap = await buildProfileMap(bottles);
  const maturity = new Map(bottles.map((b) => [String(b._id), classifyMaturity(b, profileMap) || null]));
  const withImages = await attachBottleImageUrls(bottles, userId);

  return assembleSnapshot({ userId, cellars, bottles: withImages, racks, maturity });
}

module.exports = { buildOfflineSnapshot, assembleSnapshot, SNAPSHOT_SCHEMA };
