// Editing a wall rack that is already in use. A wall's positions run box
// after box (utils/wallGeometry.js), so changing one box renumbers every box
// after it; this carries everything numbered by a position along: the placed
// bottles, the switched-off slots, the zones, and the slot an opened bottle
// left (Bottle.openedFromSlot). Called by PUT /api/racks/:id only; there is no
// MCP tool that reshapes a rack.
const Bottle = require('../models/Bottle');
const { planWallEdit } = require('../utils/wallGeometry');
const { logger } = require('./audit');

/**
 * Plan the renumbering of a loaded wall for the shape `after`
 * ({ rows, cols, typeConfig }), before anything on the rack is changed.
 * Returns { error } when a bottle would lose its place (the route answers
 * 400), else the plan for renumberWall and renumberOpenedFromSlots.
 */
async function planWallRenumber(rack, after) {
  // Within the rack's cellar (an indexed field): a bottle can only be put back
  // into a rack of the cellar it is in (bottleOps.putBackInSlot).
  const opened = await Bottle.find({ cellar: rack.cellar, 'openedFromSlot.rack': rack._id }).select('openedFromSlot').lean();
  const plan = planWallEdit(
    { rows: rack.rows, cols: rack.cols, typeConfig: rack.typeConfig },
    after,
    {
      bottles: (rack.slots || []).map((s) => s.position),
      marked: [
        ...(rack.disabledPositions || []),
        ...(rack.zones || []).flatMap((z) => z.positions || []),
        ...opened.map((b) => b.openedFromSlot.position),
      ],
    },
  );
  return plan.error ? plan : { ...plan, opened };
}

const moved = (plan, positions) => positions
  .filter((p) => plan.move.has(p))
  .map((p) => plan.move.get(p))
  .sort((a, b) => a - b);

/**
 * Apply a plan to the rack document (not saved here): every bottle, every
 * switched-off slot and every zone member gets its new position, and what the
 * edit removed is dropped. Zones the request itself sent are already in the
 * new numbering and are left alone.
 */
function renumberWall(rack, plan, { zonesSent = false } = {}) {
  for (const slot of rack.slots || []) slot.position = plan.move.get(slot.position);
  rack.disabledPositions = moved(plan, rack.disabledPositions || []);
  if (!zonesSent) {
    for (const zone of rack.zones || []) zone.positions = moved(plan, zone.positions || []);
  }
}

/**
 * After the rack is saved: point each opened bottle at the new number of the
 * slot it left, or forget the slot when the edit removed it. A failure here
 * leaves the rack correct, so it is logged, never thrown; but the old number
 * now names another slot, so those bottles are then made to forget theirs
 * (no way back is better than a wrong one).
 */
async function renumberOpenedFromSlots(rack, plan) {
  const ops = (plan.opened || [])
    .map((b) => ({ id: b._id, from: b.openedFromSlot.position, to: plan.move.get(b.openedFromSlot.position) }))
    .filter((o) => o.to !== o.from)
    .map((o) => ({
      updateOne: {
        filter: { _id: o.id, 'openedFromSlot.rack': rack._id, 'openedFromSlot.position': o.from },
        update: o.to ? { $set: { 'openedFromSlot.position': o.to } } : { $set: { openedFromSlot: null } },
      },
    }));
  if (ops.length === 0) return;
  try {
    await Bottle.bulkWrite(ops, { ordered: false });
  } catch (err) {
    logger.warn({ err: err.message, rack: String(rack._id), bottles: ops.length }, 'wall edit: could not renumber the slots opened bottles left');
    try {
      await Bottle.updateMany(
        { _id: { $in: ops.map((o) => o.updateOne.filter._id) }, 'openedFromSlot.rack': rack._id },
        { $set: { openedFromSlot: null } },
      );
    } catch (err2) {
      logger.warn({ err: err2.message, rack: String(rack._id), bottles: ops.length }, 'wall edit: could not clear the slots opened bottles left either');
    }
  }
}

module.exports = { planWallRenumber, renumberWall, renumberOpenedFromSlots };
