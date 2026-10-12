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
// Same bound the PUT route applies (routes/racks.js MAX_RACK_DIM).
const MAX_RACK_DIM = 20;
const isRackDim = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_RACK_DIM;
const Bottle = require('../models/Bottle');
const { logAudit } = require('./audit');
const { getMaxPosition, validateDoubleHeightRows, validateCabinetConfig } = require('../utils/rackGeometry');
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
 * Create a GRID-family rack in an access-checked cellar — the ONE
 * implementation behind the grid branch of REST POST /api/racks and the MCP
 * create_rack tool (the route delegates here; H1 of the 2026-07-17 MCP
 * audit). Modular racks stay a REST-only route path (their validation has no
 * MCP twin to drift against). typeConfig (double-height rows etc.) is
 * accepted and validated; MCP simply doesn't pass it in v1.
 */
/** The rack group as stored: trimmed, capped, empty → null (ungrouped). */
function normalizeRackGroup(group) {
  if (group === undefined) return undefined;
  const s = typeof group === 'string' ? group.trim().slice(0, 40) : '';
  return s || null;
}

async function createGridRack(cellarDoc, { name, type = 'grid', rows = 4, cols = 8, typeConfig, group }, req) {
  if (!name || !String(name).trim()) return { error: { status: 400, message: 'Rack name is required' } };
  if (type && !RACK_TYPES.includes(type)) {
    return { error: { status: 400, message: `Invalid rack type. Must be one of: ${RACK_TYPES.join(', ')}` } };
  }
  // The schema's min/max fires only at save(), after validateCabinetConfig
  // has compared the shelf list against parseInt(rows) — so a rows of 5.5
  // used to save as a cabinet with 5.5 shelves (audit 2026-09-16). MCP
  // already enforces this through zod; REST did not.
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
    rack.typeConfig = typeConfig;
  } else if (rack.type === 'cabinet') {
    return { error: { status: 400, message: 'shelfRows is required for a cabinet rack' } };
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
  const pos = parseInt(position, 10);
  if (isNaN(pos)) return { error: { status: 400, message: 'Invalid position' } };
  const maxPos = getMaxPosition(rack);
  if (pos < 1 || pos > maxPos) return { error: { status: 400, message: `Position must be 1–${maxPos}` } };
  if ((rack.disabledPositions || []).includes(pos)) return { error: { status: 400, message: 'This slot is disabled' } };

  const bottle = await Bottle.findOne({ _id: bottleId, cellar: rack.cellar }).select('_id status');
  if (!bottle) return { error: { status: 404, message: 'Bottle not found in this cellar' } };
  // Consuming a bottle clears its rack slot (bottleOps.consumeBottle); the
  // reverse must hold too — a consumed bottle cannot be put into a slot, from
  // any surface (web slot picker, post-add placing queue, MCP place_bottle).
  // Audit 2026-09-14: bottles added straight into the drinking history were
  // offered for placement and this accepted them.
  if (bottle.status === 'ordered') {
    return { error: { status: 400, message: 'This bottle is on order and has not arrived yet — mark it as arrived before placing it in a rack' } };
  }
  if (bottle.status && bottle.status !== 'active') {
    return { error: { status: 400, message: 'Only a bottle still in the cellar can be placed in a rack — this one is consumed' } };
  }

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
  // A bottle on order may be moved too: an order booked to the wrong cellar
  // is redirected before it arrives.
  if (bottle.status !== 'active' && bottle.status !== 'ordered') {
    return { error: { status: 400, message: 'Only bottles in the cellar or on order can be moved' } };
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

const slotBottleId = (s) => String(s.bottle && s.bottle._id ? s.bottle._id : s.bottle);

/**
 * Move the bottles of one rack into another rack of the same cellar (forum
 * feedback 2026-10-12: a rack rebuilt as a wine cabinet meant moving every
 * bottle across by hand, one at a time). Both racks are loaded and
 * access-checked by the caller.
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
  createCellar, createGridRack, placeBottleInRack, clearRackSlot, moveBottleToCellar,
  buildAnnotatedEntries, validateArrangementTarget, applyArrangement, moveRackBottles,
};
