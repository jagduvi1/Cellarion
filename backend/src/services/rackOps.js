// Shared cellar/rack/placement mutations — ONE implementation for the REST
// routes and the MCP tools. Placement's "one bottle per slot" and
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
// Same bound the PUT route applies (routes/racks.js MAX_RACK_DIM).
const MAX_RACK_DIM = 20;
const isRackDim = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_RACK_DIM;
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const { logAudit } = require('./audit');
const { getMaxPosition, validateDoubleHeightRows, validateCabinetConfig } = require('../utils/rackGeometry');
const { validateWallConfig } = require('../utils/wallGeometry');
const { removeFromRacks } = require('./bottleOps');
const { parseSlotPosition, isValidId } = require('../utils/validation');
const { getCellarRole } = require('../utils/cellarAccess');
const { ROLE_LEVELS } = require('../middleware/bottleAccess');

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

/** The rack group as stored: trimmed, capped, empty → null (ungrouped). */
function normalizeRackGroup(group) {
  if (group === undefined) return undefined;
  const s = typeof group === 'string' ? group.trim().slice(0, 40) : '';
  return s || null;
}

/**
 * Create a GRID-family rack in an access-checked cellar — the ONE
 * implementation behind the grid branch of REST POST /api/racks and the MCP
 * create_rack tool (the route delegates here). Modular racks stay a REST-only
 * route path (their validation has no MCP twin to drift against). typeConfig
 * (double-height rows, cabinet shelves, a wall's boxes) is accepted and
 * validated; MCP passes it for a cabinet and for a wall.
 */
async function createGridRack(cellarDoc, { name, type = 'grid', rows = 4, cols = 8, typeConfig, group }, req) {
  if (!name || !String(name).trim()) return { error: { status: 400, message: 'Rack name is required' } };
  if (type && !RACK_TYPES.includes(type)) {
    return { error: { status: 400, message: `Invalid rack type. Must be one of: ${RACK_TYPES.join(', ')}` } };
  }
  // The schema's min/max fires only at save(), after validateCabinetConfig
  // has compared the shelf list against parseInt(rows) — so a rows of 5.5
  // would save as a cabinet with 5.5 shelves. MCP enforces this through zod
  // too; this check is what holds it for REST.
  if ((rows != null && !isRackDim(rows)) || (cols != null && !isRackDim(cols))) {
    return { error: { status: 400, message: `rows and cols must be whole numbers between 1 and ${MAX_RACK_DIM}` } };
  }
  const rack = new Rack({
    cellar: cellarDoc._id,
    user: cellarDoc.user, // rack owned by the cellar owner
    name: String(name).trim(),
    type: type || 'grid',
    rows: rows || 4,
    cols: cols || 8,
    group: normalizeRackGroup(group) ?? null,
  });
  if (typeConfig) {
    const dhrError = validateDoubleHeightRows(typeConfig, rack.type, rack.rows, false);
    if (dhrError) return { error: { status: 400, message: dhrError } };
    const cabError = validateCabinetConfig(typeConfig, rack.type, rack.rows, false, rack.cols);
    if (cabError) return { error: { status: 400, message: cabError } };
    const wallError = validateWallConfig(typeConfig, rack.type, rack.rows, rack.cols, false);
    if (wallError) return { error: { status: 400, message: wallError } };
    rack.typeConfig = typeConfig;
  } else if (rack.type === 'cabinet') {
    return { error: { status: 400, message: 'shelfRows is required for a cabinet rack' } };
  } else if (rack.type === 'wall') {
    return { error: { status: 400, message: 'boxes is required for a wall rack' } };
  }
  try {
    await rack.save();
  } catch (err) {
    if (err.code === 11000) return { error: { status: 409, message: 'A rack with that name already exists in this cellar', code: 'duplicate' } };
    if (err.name === 'ValidationError') return { error: { status: 400, message: err.message } };
    throw err;
  }
  logAudit(req, 'rack.create', { type: 'rack', id: rack._id, cellarId: cellarDoc._id }, { name: rack.name, ...(rack.group ? { group: rack.group } : {}) });
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
  const pos = parseSlotPosition(position);
  if (pos === null) return { error: { status: 400, message: 'Invalid position' } };
  const maxPos = getMaxPosition(rack);
  if (pos < 1 || pos > maxPos) return { error: { status: 400, message: `Position must be 1–${maxPos}` } };
  if ((rack.disabledPositions || []).includes(pos)) return { error: { status: 400, message: 'This slot is disabled' } };

  const bottle = await Bottle.findOne({ _id: bottleId, cellar: rack.cellar }).select('_id status');
  if (!bottle) return { error: { status: 404, message: 'Bottle not found in this cellar' } };
  // Consuming a bottle clears its rack slot (bottleOps.consumeBottle); the
  // reverse must hold too — a consumed bottle cannot be put into a slot, from
  // any surface (web slot picker, post-add placing queue, MCP place_bottle).
  // Bottles added straight into the drinking history were
  // offered for placement and this accepted them.
  if (bottle.status === 'ordered') {
    return { error: { status: 400, message: 'This bottle is on order and has not arrived yet — mark it as arrived before placing it in a rack' } };
  }
  if (bottle.status && bottle.status !== 'active') {
    return { error: { status: 400, message: 'Only a bottle still in the cellar can be placed in a rack — this one is consumed' } };
  }

  // The stored id from here on, never the caller's spelling of it: an id
  // sent in upper case names the same bottle, but as text it would not equal
  // the slot that already holds it and the bottle would get a second slot.
  const id = String(bottle._id);
  const occupant = rack.slots.find((s) => s.position === pos && String(s.bottle) !== id);
  const displaced = occupant ? String(occupant.bottle) : null;
  const oldSlot = rack.slots.find((s) => String(s.bottle) === id);
  const previousPosition = oldSlot ? oldSlot.position : null;

  // Take the bottle out of the other rack that holds it (this rack is handled
  // in memory below — an external $pull would trip optimistic concurrency),
  // and keep the slot it sat in so a save that fails can put it back. The
  // unique slots.bottle index means at most one other rack holds it. $inc __v
  // so a concurrent whole-slots writer on THAT rack (auto_arrange apply/undo)
  // VersionErrors instead of re-inserting the bottle it just lost — same
  // reasoning as bottleOps.removeFromRacks.
  const other = await Rack.findOneAndUpdate(
    { _id: { $ne: rack._id }, cellar: rack.cellar, 'slots.bottle': bottle._id },
    { $pull: { slots: { bottle: bottle._id } }, $inc: { __v: 1 } },
    { projection: { slots: { $elemMatch: { bottle: bottle._id } } }, lean: true }
  );
  const cameFrom = other && other.slots && other.slots[0] ? { rackId: other._id, slot: other.slots[0] } : null;
  // A bottle in a second other rack exists only where that index could not be
  // built (models/Rack.js says when): clear those too. One more write, and
  // only when the bottle came from another rack.
  if (other) {
    await Rack.updateMany(
      { _id: { $ne: rack._id }, cellar: rack.cellar, 'slots.bottle': bottle._id },
      { $pull: { slots: { bottle: bottle._id } }, $inc: { __v: 1 } }
    );
  }

  // The procedural one-per-slot / one-slot-per-bottle invariant.
  rack.slots = rack.slots.filter((s) => s.position !== pos && String(s.bottle) !== id);
  rack.slots.push({ position: pos, bottle: bottle._id });
  try {
    await rack.save();
  } catch (err) {
    // Unique slots.bottle index: a concurrent placement of this bottle into
    // ANOTHER rack won the race — different documents, so only the index
    // (not __v) can see it. The bottle is placed; nothing to put back.
    if (err.code === 11000) {
      return { error: { status: 409, message: 'This bottle was just placed in another rack — refresh and retry.', code: 'conflict' } };
    }
    // The bottle is in this rack's old state or in no rack at all: give it
    // back the slot it was taken from, so a refused placement moves nothing.
    await putBackSlot(cameFrom, rack.cellar);
    if (err.name === 'VersionError') {
      return { error: { status: 409, message: 'This rack was modified by another request — refresh and retry.', code: 'conflict' } };
    }
    throw err;
  }

  // The bottle was read before the save. A move to another cellar or a drink
  // that landed in between cleared its slots before this one existed, so look
  // again: a bottle this rack may no longer hold leaves the slot, and the
  // bottle it pushed out gets the slot back.
  let stillHere = true;
  try {
    stillHere = !!(await onShelfIn(bottle._id, rack.cellar));
  } catch (err) {
    // The placement is saved. A read that fails here must not turn it into an
    // error with no audit row, so it stands.
    console.warn('[rackOps] could not look at the placed bottle again:', err.message);
  }
  if (!stillHere) {
    await Rack.updateOne({ _id: rack._id }, { $pull: { slots: { bottle: bottle._id } }, $inc: { __v: 1 } });
    rack.slots = rack.slots.filter((s) => String(s.bottle) !== id);
    if (occupant) {
      const slot = typeof occupant.toObject === 'function' ? occupant.toObject() : occupant;
      await putBackSlot({ rackId: rack._id, slot }, rack.cellar);
      rack.slots.push(slot);
    }
    return { error: { status: 409, message: 'This bottle was moved or taken out of the cellar meanwhile — refresh and retry.', code: 'conflict' } };
  }

  logAudit(req, 'rack.slot_assign', { type: 'rack', id: rack._id, cellarId: rack.cellar }, { position: pos, bottleId: id, ...(displaced ? { displaced } : {}) });
  return { rack, displaced, previousPosition, position: pos };
}

// A bottle a rack of this cellar may hold: in the cellar, and on the shelf.
const onShelfIn = (bottleId, cellarId) => Bottle.exists({ _id: bottleId, cellar: cellarId, status: { $in: ['active', null] } });

/**
 * Give a bottle back the slot a refused placement took it from, when that
 * position is still free and the bottle sits nowhere else in the rack. Best
 * effort: a slot taken meanwhile, or the bottle placed in another rack (the
 * unique slots.bottle index refuses it), leaves things as they are. A bottle
 * that was drunk or moved to another cellar while it was out of the rack is
 * taken out again: its own sweep of the racks ran when it held no slot.
 */
async function putBackSlot(cameFrom, cellarId) {
  if (!cameFrom) return;
  const { rackId, slot } = cameFrom;
  try {
    const res = await Rack.updateOne(
      { _id: rackId, deletedAt: null, 'slots.position': { $ne: slot.position }, 'slots.bottle': { $ne: slot.bottle } },
      { $push: { slots: slot }, $inc: { __v: 1 } }
    );
    if (res && res.modifiedCount && !(await onShelfIn(slot.bottle, cellarId))) {
      await Rack.updateOne({ _id: rackId }, { $pull: { slots: { bottle: slot.bottle } }, $inc: { __v: 1 } });
    }
  } catch (err) {
    console.warn('[rackOps] placement put-back failed:', err.message);
  }
}

/**
 * Clear a rack slot (loaded, editor-access-checked rack): the REST route
 * DELETE /api/racks/:id/slots/:position and the MCP tool unplace_bottle.
 * An empty slot of the rack is fine; a position the rack does not have is not.
 * Returns { error } | { rack, cleared: bottleId|null }.
 */
async function clearRackSlot(rack, position, req) {
  const pos = parseSlotPosition(position);
  if (pos === null) return { error: { status: 400, message: 'Invalid position' } };
  const had = rack.slots.find((s) => s.position === pos);
  // A bottle can always be taken out, wherever it sits. An empty position is
  // only a slot when the rack has it.
  if (!had) {
    const maxPos = getMaxPosition(rack);
    if (pos < 1 || pos > maxPos) return { error: { status: 400, message: `Position must be 1–${maxPos}` } };
  }
  rack.slots = rack.slots.filter((s) => s.position !== pos);
  try {
    await rack.save();
  } catch (err) {
    if (err.name === 'VersionError') {
      return { error: { status: 409, message: 'This rack was modified by another request — refresh and retry.', code: 'conflict' } };
    }
    throw err;
  }
  logAudit(req, 'rack.slot_clear', { type: 'rack', id: rack._id, cellarId: rack.cellar }, { position: pos, ...(had ? { bottleId: String(had.bottle) } : {}) });
  return { rack, cleared: had ? String(had.bottle) : null };
}

/**
 * The role a cellar move needs on BOTH cellars, the one the bottle leaves and
 * the one it enters. An editor of a shared cellar moves bottles in and out of
 * it: the same reach as adding a bottle there or deleting one. A viewer never
 * moves anything.
 */
const MOVE_MIN_ROLE = 'editor';

/**
 * The destination of a cellar move: an active cellar where the user holds
 * MOVE_MIN_ROLE. Null when it is missing, deleted or not theirs to move into:
 * one answer for all three, so the reply reveals nothing about a cellar the
 * caller cannot see. Callers: POST /api/bottles/:id/move, POST
 * /api/bottles/bulk-move, MCP move_bottle and its undo_last.
 */
async function findMoveDestination(userId, cellarId) {
  const id = String(cellarId);
  if (!isValidId(id)) return null;
  const cellar = await Cellar.findById(id);
  if (!cellar || cellar.deletedAt) return null;
  const role = getCellarRole(cellar, userId);
  return (ROLE_LEVELS[role] || 0) >= ROLE_LEVELS[MOVE_MIN_ROLE] ? cellar : null;
}

/**
 * Why a move that hands a bottle to another account is refused, or null.
 * The mover must own one of the two cellars: their own bottle into a cellar
 * they edit, or a bottle of a cellar they edit into their own, never one
 * friend's bottle into another friend's cellar. And a demo account never takes
 * a bottle over, since it is erased within hours with everything it owns (the
 * rule services/cellarTransfer applies to a whole cellar).
 */
async function ownerChangeRefusal(sourceCellar, destCellar, moverId) {
  const mover = String(moverId);
  if (String(sourceCellar.user) !== mover && String(destCellar.user) !== mover) {
    return { status: 403, code: 'not_your_cellar', message: 'A bottle can move between two other people\'s cellars only when one of them is yours.' };
  }
  const newOwner = await User.findById(destCellar.user).select('isDemo').lean();
  if (!newOwner) return { status: 404, code: 'not_found', message: 'Destination cellar not found' };
  if (newOwner.isDemo) {
    return { status: 400, code: 'demo_owner', message: 'A demo account cannot take over bottles from another account.' };
  }
  return null;
}

// The reminders the previous owner already had for this bottle. Cleared on an
// owner change, so the new owner is reminded too.
const OWNER_REMINDER_MARKS = {
  drinkWindowNotifiedStatus: null, drinkWindowNotifiedAt: null,
  reservationNotifiedAt: null, openBottleNotifiedAt: null, arrivalNotifiedAt: undefined,
};

/**
 * On an owner change, the bottle's journey keeps the dates of its earlier
 * cellars but only the names of those the new owner owns: another account's
 * cellar names stay with that account, are not shown to the new owner's
 * members, and do not outlive that account's erasure.
 */
async function keepJourneyToNewOwner(bottle, newOwner) {
  const ids = bottle.cellarHistory.map((h) => h.cellar).filter(Boolean);
  const theirs = ids.length
    ? new Set((await Cellar.find({ _id: { $in: ids }, user: newOwner }).select('_id').lean()).map((c) => String(c._id)))
    : new Set();
  for (const h of bottle.cellarHistory) {
    if (!h.cellar || !theirs.has(String(h.cellar))) {
      h.cellar = undefined;
      h.cellarName = undefined;
    }
  }
}

/**
 * Move an ACTIVE (or on-order) bottle to another cellar. Reassigns the cellar
 * AND the bottle's owner, seeds cellarHistory, saves FIRST (so a concurrency
 * conflict leaves the source rack untouched), then unplaces from the old rack.
 * Dual audit (move.out on the source, move.in on the destination).
 * The one body behind POST /api/bottles/:id/move, POST /api/bottles/bulk-move,
 * MCP move_bottle and its undo_last; each caller has already checked
 * MOVE_MIN_ROLE on both cellars, and the owner-change rule is checked here.
 * Returns { error: { status, message, code? } } | { bottle, from: {cellarId, cellarName} }.
 */
async function moveBottleToCellar(bottle, sourceCellar, destCellar, req) {
  if (String(destCellar._id) === String(sourceCellar._id)) {
    return { error: { status: 400, message: 'Bottle is already in that cellar' } };
  }
  // A bottle on order may be moved too: an order booked to the wrong cellar
  // is redirected before it arrives.
  if (bottle.status !== 'active' && bottle.status !== 'ordered') {
    return { error: { status: 400, message: 'Only bottles in the cellar or on order can be moved' } };
  }
  const moverId = String(req.user.id);
  const ownerChanges = String(destCellar.user) !== String(sourceCellar.user);
  if (ownerChanges) {
    const refusal = await ownerChangeRefusal(sourceCellar, destCellar, moverId);
    if (refusal) return { error: refusal };
  }
  const now = new Date();
  if (bottle.cellarHistory.length === 0) {
    bottle.cellarHistory.push({
      cellar: sourceCellar._id, cellarName: sourceCellar.name,
      enteredAt: bottle.addedToCellarAt || bottle.createdAt,
    });
  }
  bottle.cellar = destCellar._id;
  // A bottle belongs to the owner of the cellar it is in, on every path that
  // puts one there (add, import, trash restore, cellar transfer). Moved into a
  // cellar someone else owns, it is theirs: their statistics and export carry
  // it, and an erasure of the mover's account no longer takes it out of that
  // cellar. What the mover wrote about it (journal entries, personal fields,
  // photo credit) stays with the mover.
  bottle.user = destCellar.user;
  if (ownerChanges) {
    Object.assign(bottle, OWNER_REMINDER_MARKS);
    await keepJourneyToNewOwner(bottle, destCellar.user);
  }
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

  // Resolve the wine name for the move audit trail (REST parity — the pre-
  // refactor route populated before auditing). Tolerant of an unpopulated ref.
  let wineName;
  try {
    await bottle.populate({ path: 'wineDefinition', select: 'name' });
    wineName = bottle.wineDefinition?.name;
  } catch { /* name is best-effort audit metadata */ }
  const meta = { wineName, vintage: bottle.vintage };
  // Each row is read by its cellar's owner (the activity log is owner-only).
  // On an owner change, the row on the cellar the mover does not own leaves
  // out the mover's own cellar: its name is the mover's, not that owner's.
  const othersRow = (rowCellar) => ownerChanges && String(rowCellar.user) !== moverId;
  logAudit(req, 'bottle.move.out',
    { type: 'bottle', id: bottle._id, cellarId: sourceCellar._id },
    othersRow(sourceCellar)
      ? { toOtherAccount: true, ...meta }
      : { toCellarId: destCellar._id, toCellarName: destCellar.name, ...meta });
  logAudit(req, 'bottle.move.in',
    { type: 'bottle', id: bottle._id, cellarId: destCellar._id },
    othersRow(destCellar)
      ? { fromOtherAccount: true, ...meta }
      : { fromCellarId: sourceCellar._id, fromCellarName: sourceCellar.name, ...meta });

  return { bottle, from: { cellarId: String(sourceCellar._id), cellarName: sourceCellar.name } };
}

/**
 * What an arrangement reads of each placed bottle — the ONE load for the web
 * Arrange preview and MCP auto_arrange, so both plan from the same data.
 * purchaseDate/createdAt anchor relative (NV) profile windows
 * (maturityUtils.bottleAnchorYear): without them an NV bottle under a curated
 * window classifies as having no window and sorts last.
 */
const ARRANGE_SLOT_POPULATE = {
  path: 'slots.bottle',
  select: 'vintage status drinkFrom drinkTo peakFrom peakUntil wineDefinition purchaseDate createdAt',
  populate: { path: 'wineDefinition', select: 'name producer type' },
};

/**
 * How many positions an arrangement can fill: the positions of the fill
 * order (default 1..maxPosition) that are not disabled. Counted from the
 * positions themselves, so a disabled entry listed twice or lying beyond the
 * rack does not shrink it. Shared by both arrange surfaces' overflow guard.
 */
function usablePositionCount(rack, positionOrder) {
  const disabled = new Set(rack.disabledPositions || []);
  const order = positionOrder || Array.from({ length: getMaxPosition(rack) }, (_, i) => i + 1);
  return order.filter((p) => !disabled.has(p)).length;
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
    // Unique slots.bottle index: one of these bottles was concurrently
    // placed into another rack — nothing was applied.
    if (err.code === 11000) {
      return { error: { status: 409, code: 'conflict', message: 'A bottle in this plan was just placed in another rack — nothing was applied.' } };
    }
    throw err;
  }
  logAudit(req, 'rack.arrange', { type: 'rack', id: rack._id, cellarId: rack.cellar }, meta);
  return { rack };
}

const slotBottleId = (s) => String(s.bottle && s.bottle._id ? s.bottle._id : s.bottle);

/**
 * Move the bottles of one rack into another rack of the same cellar, so a
 * rack rebuilt as, say, a wine cabinet does not mean moving every bottle
 * across by hand, one at a time. Both racks are loaded and access-checked by
 * the caller.
 *
 * Bottles keep their order: sorted by position in the source, they fill the
 * target's free positions (in range, not disabled, not taken) from the lowest
 * up. When the target has fewer free positions than the source has bottles,
 * the first ones by position move and the rest stay where they are.
 *
 * Two racks are two documents and a bottle may sit in one slot only (the
 * unique slots.bottle index), so the bottles leave the source FIRST and then
 * enter the target, each save under optimistic concurrency. If the target
 * write is refused, the bottles go back into the source slots they came from
 * (those still free); a bottle that cannot go back stays in the cellar,
 * unplaced — never lost and never in two slots.
 * Returns { error } | { moved, left, moves: [{ bottleId, from, to }] }.
 */
async function moveRackBottles(source, target, req) {
  if (String(source._id) === String(target._id)) {
    return { error: { status: 400, message: 'Choose a different rack to move the bottles to' } };
  }
  if (String(source.cellar) !== String(target.cellar)) {
    return { error: { status: 400, message: 'Both racks must be in the same cellar' } };
  }
  const occupied = (source.slots || []).filter((s) => s.bottle).sort((a, b) => a.position - b.position);
  if (occupied.length === 0) {
    return { error: { status: 400, code: 'empty', message: 'This rack has no bottles to move' } };
  }
  const maxPos = getMaxPosition(target);
  const disabled = new Set(target.disabledPositions || []);
  const taken = new Set((target.slots || []).map((s) => s.position));
  const free = [];
  for (let p = 1; p <= maxPos; p++) if (!disabled.has(p) && !taken.has(p)) free.push(p);
  if (free.length === 0) {
    return { error: { status: 409, code: 'full', message: 'The other rack has no free slots' } };
  }

  const moving = occupied.slice(0, free.length);
  const moves = moving.map((s, i) => ({
    bottleId: slotBottleId(s), from: s.position, to: free[i],
    ...(s.rfidTag ? { rfidTag: s.rfidTag } : {}),
  }));
  const movingIds = new Set(moves.map((m) => m.bottleId));

  // 1. Out of the source.
  source.slots = (source.slots || []).filter((s) => !movingIds.has(slotBottleId(s)));
  try {
    await source.save();
  } catch (err) {
    if (err.name === 'VersionError') {
      return { error: { status: 409, code: 'conflict', message: 'This rack was changed at the same moment — nothing was moved.' } };
    }
    throw err;
  }

  // 2. Into the target. Slot-level rfidTags follow their bottle.
  target.slots = [
    ...(target.slots || []),
    ...moves.map((m) => ({ position: m.to, bottle: m.bottleId, ...(m.rfidTag ? { rfidTag: m.rfidTag } : {}) })),
  ];
  try {
    await target.save();
  } catch (err) {
    const unplaced = await putBackIntoSource(source._id, moves);
    // The source DID change: bottles left it, and those that could not go
    // back are now unplaced. Audited either way, so the data version moves
    // and every cached layout (offline copy, search, MCP) is re-read.
    logAudit(req, 'rack.move_bottles', { type: 'rack', id: source._id, cellarId: source.cellar },
      { fromRack: String(source._id), toRack: String(target._id), moved: 0, refused: true, unplaced });
    if (err.name === 'VersionError' || err.code === 11000) {
      return {
        error: unplaced > 0
          ? { status: 409, code: 'conflict', unplaced, message: `The other rack was changed at the same moment, so nothing moved there — but ${unplaced} bottle(s) could not go back to their slots and are now unplaced in the cellar.` }
          : { status: 409, code: 'conflict', message: 'The other rack was changed at the same moment — nothing was moved.' },
      };
    }
    throw err;
  }

  const left = occupied.length - moves.length;
  logAudit(req, 'rack.move_bottles', { type: 'rack', id: target._id, cellarId: target.cellar },
    { fromRack: String(source._id), toRack: String(target._id), moved: moves.length, left });
  return { moved: moves.length, left, moves: moves.map(({ bottleId, from, to }) => ({ bottleId, from, to })) };
}

// Best effort after a refused target write: each bottle back into its old
// source slot when that slot is still free and the bottle sits in no rack.
// Returns how many bottles are left unplaced — not back, and in no rack.
async function putBackIntoSource(sourceId, moves) {
  const ids = moves.map((m) => m.bottleId);
  try {
    const fresh = await Rack.findOne({ _id: sourceId, deletedAt: null });
    if (!fresh) return await countUnplaced(ids);
    const taken = new Set((fresh.slots || []).map((s) => s.position));
    const placedElsewhere = new Set((await Rack.find({ 'slots.bottle': { $in: ids } }).select('slots.bottle').lean())
      .flatMap((r) => (r.slots || []).map(slotBottleId)));
    const back = [];
    for (const m of moves) {
      if (taken.has(m.from) || placedElsewhere.has(m.bottleId)) continue;
      back.push({ position: m.from, bottle: m.bottleId, ...(m.rfidTag ? { rfidTag: m.rfidTag } : {}) });
    }
    if (back.length > 0) {
      fresh.slots = [...fresh.slots, ...back];
      await fresh.save();
    }
    return moves.length - back.length - moves.filter((m) => placedElsewhere.has(m.bottleId)).length;
  } catch (err) {
    console.warn('[rackOps] moveRackBottles put-back failed (bottles left unplaced):', err.message);
    return countUnplaced(ids);
  }
}

// How many of these bottles sit in no rack at all.
async function countUnplaced(ids) {
  try {
    const placed = new Set((await Rack.find({ 'slots.bottle': { $in: ids } }).select('slots.bottle').lean())
      .flatMap((r) => (r.slots || []).map(slotBottleId)));
    return ids.filter((id) => !placed.has(id)).length;
  } catch {
    return ids.length;
  }
}

module.exports = {
  normalizeRackGroup,
  createCellar, createGridRack, placeBottleInRack, clearRackSlot,
  MOVE_MIN_ROLE, findMoveDestination, moveBottleToCellar,
  ARRANGE_SLOT_POPULATE, usablePositionCount,
  buildAnnotatedEntries, validateArrangementTarget, applyArrangement, moveRackBottles,
};
