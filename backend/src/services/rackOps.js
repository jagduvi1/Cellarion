// Shared cellar/rack/placement mutations — ONE implementation for the REST
// routes and the MCP tools (plan §7). Placement's "one bottle per slot" and
// "one slot per bottle" invariants are PROCEDURAL (no unique index on
// slots.position), so the exact filter-then-push sequence lives here once and
// both surfaces call it — a hand-rolled copy could create duplicate-position
// slots.
//
// Each fn takes access-checked inputs (the caller owns authorization) plus a
// req-like object for audit. Returns { error: { status, message, code? } } for
// client faults, or the mutated document. VersionError (optimistic concurrency
// on Rack) surfaces as a 409/conflict so a losing concurrent writer retries.
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const { logAudit } = require('./audit');
const { getMaxPosition } = require('../utils/rackGeometry');
const { removeFromRacks } = require('./bottleOps');

const { RACK_TYPES } = Rack;

/** Create a cellar owned by userId. Mirrors POST /api/cellars. */
async function createCellar({ name, description }, req) {
  if (!name || !String(name).trim()) return { error: { status: 400, message: 'Cellar name is required' } };
  const cellar = new Cellar({
    name: String(name).trim(),
    description: description ? String(description).trim() : '',
    user: req.user.id,
  });
  try {
    await cellar.save();
  } catch (err) {
    if (err.code === 11000) return { error: { status: 409, message: 'You already have a cellar with this name', code: 'duplicate' } };
    if (err.name === 'ValidationError') return { error: { status: 400, message: err.message } };
    throw err;
  }
  logAudit(req, 'cellar.create', { type: 'cellar', id: cellar._id, cellarId: cellar._id }, { name: cellar.name });
  return { cellar };
}

/**
 * Create a GRID-family rack in an access-checked cellar (v1: no modular racks
 * — that path has its own validation and the read tools treat it specially).
 * Mirrors the grid branch of POST /api/racks.
 */
async function createGridRack(cellarDoc, { name, type = 'grid', rows = 4, cols = 8 }, req) {
  if (!name || !String(name).trim()) return { error: { status: 400, message: 'Rack name is required' } };
  if (type && !RACK_TYPES.includes(type)) {
    return { error: { status: 400, message: `Invalid rack type. Must be one of: ${RACK_TYPES.join(', ')}` } };
  }
  const rack = new Rack({
    cellar: cellarDoc._id,
    user: cellarDoc.user, // rack owned by the cellar owner
    name: String(name).trim(),
    type: type || 'grid',
    rows: rows || 4,
    cols: cols || 8,
  });
  try {
    await rack.save();
  } catch (err) {
    if (err.code === 11000) return { error: { status: 409, message: 'A rack with that name already exists in this cellar', code: 'duplicate' } };
    if (err.name === 'ValidationError') return { error: { status: 400, message: err.message } };
    throw err;
  }
  logAudit(req, 'rack.create', { type: 'rack', id: rack._id, cellarId: cellarDoc._id }, { name: rack.name });
  return { rack };
}

/**
 * Assign a bottle to a rack slot (loaded, editor-access-checked rack). The
 * bottle must belong to the rack's cellar. A bottle occupies at most one slot:
 * its placement in any other rack of the cellar is cleared first, and its old
 * slot in THIS rack is dropped. If the target slot was occupied, the displaced
 * bottle id is returned so the caller can tell the user. Mirrors
 * PUT /api/racks/:id/slots/:position.
 * Returns { error } | { rack, displaced: bottleId|null, previousPosition: n|null }.
 */
async function placeBottleInRack(rack, position, bottleId, req) {
  const pos = parseInt(position, 10);
  if (isNaN(pos)) return { error: { status: 400, message: 'Invalid position' } };
  const maxPos = getMaxPosition(rack);
  if (pos < 1 || pos > maxPos) return { error: { status: 400, message: `Position must be 1–${maxPos}` } };
  if ((rack.disabledPositions || []).includes(pos)) return { error: { status: 400, message: 'This slot is disabled' } };

  const bottle = await Bottle.findOne({ _id: bottleId, cellar: rack.cellar }).select('_id');
  if (!bottle) return { error: { status: 404, message: 'Bottle not found in this cellar' } };

  const occupant = rack.slots.find((s) => s.position === pos && String(s.bottle) !== String(bottleId));
  const displaced = occupant ? String(occupant.bottle) : null;
  const oldSlot = rack.slots.find((s) => String(s.bottle) === String(bottleId));
  const previousPosition = oldSlot ? oldSlot.position : null;

  // Clear the bottle from other racks in the cellar (this rack handled in
  // memory below — an external $pull would trip optimistic concurrency).
  // $inc __v so a concurrent whole-slots writer on one of THOSE racks
  // (auto_arrange apply/undo) VersionErrors instead of re-inserting the
  // bottle it just lost — same reasoning as bottleOps.removeFromRacks.
  await Rack.updateMany(
    { _id: { $ne: rack._id }, cellar: rack.cellar, 'slots.bottle': bottleId },
    { $pull: { slots: { bottle: bottleId } }, $inc: { __v: 1 } }
  );

  // The procedural one-per-slot / one-slot-per-bottle invariant.
  rack.slots = rack.slots.filter((s) => s.position !== pos && String(s.bottle) !== String(bottleId));
  rack.slots.push({ position: pos, bottle: bottleId });
  try {
    await rack.save();
  } catch (err) {
    if (err.name === 'VersionError') {
      return { error: { status: 409, message: 'This rack was modified by another request — refresh and retry.', code: 'conflict' } };
    }
    // Unique slots.bottle index (prior-audit M4): a concurrent placement of
    // this bottle into ANOTHER rack won the race — different documents, so
    // only the index (not __v) can see it.
    if (err.code === 11000) {
      return { error: { status: 409, message: 'This bottle was just placed in another rack — refresh and retry.', code: 'conflict' } };
    }
    throw err;
  }
  logAudit(req, 'rack.slot_assign', { type: 'rack', id: rack._id, cellarId: rack.cellar }, { position: pos });
  return { rack, displaced, previousPosition, position: pos };
}

/** Clear a rack slot. Mirrors DELETE /api/racks/:id/slots/:position. */
async function clearRackSlot(rack, position, req) {
  const pos = parseInt(position, 10);
  if (isNaN(pos)) return { error: { status: 400, message: 'Invalid position' } };
  const had = rack.slots.find((s) => s.position === pos);
  rack.slots = rack.slots.filter((s) => s.position !== pos);
  try {
    await rack.save();
  } catch (err) {
    if (err.name === 'VersionError') {
      return { error: { status: 409, message: 'This rack was modified by another request — refresh and retry.', code: 'conflict' } };
    }
    throw err;
  }
  logAudit(req, 'rack.slot_clear', { type: 'rack', id: rack._id, cellarId: rack.cellar }, { position: pos });
  return { rack, cleared: had ? String(had.bottle) : null };
}

/**
 * Move an ACTIVE bottle to a destination cellar the user OWNS. Reassigns the
 * cellar, seeds cellarHistory, saves FIRST (so a concurrency conflict leaves
 * the source rack untouched), then unplaces from the old rack. Dual audit
 * (move.out / move.in). Mirrors POST /api/bottles/:id/move.
 * `destCellar` must already be verified owned by the caller.
 * Returns { error } | { bottle, fromCellar, from: {cellarId, cellarName} }.
 */
async function moveBottleToCellar(bottle, sourceCellar, destCellar, req) {
  if (String(destCellar._id) === String(sourceCellar._id)) {
    return { error: { status: 400, message: 'Bottle is already in that cellar' } };
  }
  if (bottle.status !== 'active') {
    return { error: { status: 400, message: 'Only active bottles can be moved' } };
  }
  const now = new Date();
  if (bottle.cellarHistory.length === 0) {
    bottle.cellarHistory.push({
      cellar: sourceCellar._id, cellarName: sourceCellar.name,
      enteredAt: bottle.addedToCellarAt || bottle.createdAt,
    });
  }
  bottle.cellar = destCellar._id;
  bottle.addedToCellarAt = now;
  bottle.cellarHistory.push({ cellar: destCellar._id, cellarName: destCellar.name, enteredAt: now });
  try {
    await bottle.save();
  } catch (err) {
    if (err.name === 'VersionError') {
      return { error: { status: 409, message: 'This bottle was modified by another request — refresh and retry.', code: 'conflict' } };
    }
    throw err;
  }
  await removeFromRacks(bottle._id);
  require('./search').indexBottle(bottle._id);

  // Resolve the wine name for the move audit trail (REST parity — the pre-
  // refactor route populated before auditing). Tolerant of an unpopulated ref.
  let wineName;
  try {
    await bottle.populate({ path: 'wineDefinition', select: 'name' });
    wineName = bottle.wineDefinition?.name;
  } catch { /* name is best-effort audit metadata */ }
  const meta = { wineName, vintage: bottle.vintage };
  logAudit(req, 'bottle.move.out',
    { type: 'bottle', id: bottle._id, cellarId: sourceCellar._id },
    { toCellarId: destCellar._id, toCellarName: destCellar.name, ...meta });
  logAudit(req, 'bottle.move.in',
    { type: 'bottle', id: bottle._id, cellarId: destCellar._id },
    { fromCellarId: sourceCellar._id, fromCellarName: sourceCellar.name, ...meta });

  return { bottle, from: { cellarId: String(sourceCellar._id), cellarName: sourceCellar.name } };
}

/**
 * Occupied slots of a (slots.bottle-populated) rack annotated with the same
 * maturityStatus the rack views color by (routes/racks withMaturity) — the
 * input shape utils/rackArrange.buildArrangePlan sorts on. Shared so an MCP
 * auto_arrange and a future REST arrange endpoint classify identically.
 */
async function buildAnnotatedEntries(rack) {
  const { classifyMaturity, buildProfileMap } = require('../utils/maturityUtils');
  const bottles = (rack.slots || []).map((s) => s.bottle).filter(Boolean);
  const profileMap = await buildProfileMap(bottles);
  return (rack.slots || [])
    .filter((s) => s.bottle)
    .map((s) => {
      const b = s.bottle.toObject ? s.bottle.toObject() : s.bottle;
      b.maturityStatus = classifyMaturity(b, profileMap) || null;
      return { position: s.position, bottle: b };
    });
}

/**
 * Validate a CLIENT-SUPPLIED arrangement target against the rack's current
 * state: it must be a pure PERMUTATION of the bottles currently in the rack
 * (same multiset of bottle ids — nothing added, dropped, or duplicated) onto
 * unique positions. Geometry (range/disabled) is applyArrangement's job.
 * The REST arrange endpoint needs this because its client computes nothing —
 * but a hand-crafted request must not be able to inject or clone bottles.
 * Returns { ok: true } | { error: { status: 400, message } }.
 */
function validateArrangementTarget(rack, target) {
  if (!Array.isArray(target) || target.length === 0) {
    return { error: { status: 400, message: 'target must be a non-empty array of { position, bottleId }' } };
  }
  const positions = new Set();
  for (const t of target) {
    if (!t || !Number.isInteger(t.position) || typeof (t.bottleId ?? '') !== 'string' || !t.bottleId) {
      return { error: { status: 400, message: 'each target entry needs an integer position and a bottleId' } };
    }
    if (positions.has(t.position)) {
      return { error: { status: 400, message: `duplicate target position ${t.position}` } };
    }
    positions.add(t.position);
  }
  const current = (rack.slots || []).filter((s) => s.bottle).map((s) => String(s.bottle._id || s.bottle)).sort();
  const proposed = target.map((t) => String(t.bottleId)).sort();
  const same = current.length === proposed.length && current.every((id, i) => id === proposed[i]);
  if (!same) {
    return { error: { status: 400, message: 'target must contain exactly the bottles currently in this rack (a re-ordering, not an edit)' } };
  }
  return { ok: true };
}

/**
 * Apply a full slot assignment to an access-checked rack in ONE atomic save —
 * no partial arrangements. `target` = [{ position, bottleId }]. Optimistic
 * concurrency (Rack versionKey) turns a concurrent slot write into a clean
 * conflict instead of a lost update. Audits rack.arrange with the given meta.
 * Returns { rack } or { error: { status: 409|400, message, code: 'conflict' } }.
 */
async function applyArrangement(rack, target, req, meta = {}) {
  // Re-validate geometry at WRITE time, not plan time: the rack may have been
  // resized or had positions disabled since the plan was computed (a stored
  // arrange preview is valid for 15 minutes) — every other placement surface
  // refuses disabled/out-of-range positions, so this one must too.
  const maxPos = getMaxPosition(rack);
  const disabled = new Set(rack.disabledPositions || []);
  const bad = target.find((t) => !Number.isInteger(t.position) || t.position < 1 || t.position > maxPos || disabled.has(t.position));
  if (bad) {
    return { error: { status: 409, code: 'conflict', message: `Position ${bad.position} is no longer usable (rack resized or slot disabled) — nothing was applied.` } };
  }
  // Slot-level rfidTags follow their bottle through the rewrite. No current
  // writer sets them, but silently wiping a schema field on every arrange
  // would be a trap for whichever feature starts using it.
  const tagOf = new Map((rack.slots || []).filter((s) => s.rfidTag).map((s) => [String(s.bottle), s.rfidTag]));
  rack.slots = target.map((t) => ({
    position: t.position,
    bottle: t.bottleId,
    ...(tagOf.has(String(t.bottleId)) ? { rfidTag: tagOf.get(String(t.bottleId)) } : {}),
  }));
  try {
    await rack.save();
  } catch (err) {
    if (err.name === 'VersionError') {
      return { error: { status: 409, code: 'conflict', message: 'The rack was modified at the same moment — nothing was applied.' } };
    }
    // Unique slots.bottle index (prior-audit M4): one of these bottles was
    // concurrently placed into another rack — nothing was applied.
    if (err.code === 11000) {
      return { error: { status: 409, code: 'conflict', message: 'A bottle in this plan was just placed in another rack — nothing was applied.' } };
    }
    throw err;
  }
  logAudit(req, 'rack.arrange', { type: 'rack', id: rack._id, cellarId: rack.cellar }, meta);
  return { rack };
}

module.exports = {
  createCellar, createGridRack, placeBottleInRack, clearRackSlot, moveBottleToCellar,
  buildAnnotatedEntries, validateArrangementTarget, applyArrangement,
};
