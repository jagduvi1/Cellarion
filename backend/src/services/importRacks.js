// The racks of a bottle import: the ones a file names are created, then the
// imported bottles are placed in them. Both steps belong to
// POST /api/bottles/import/confirm (routes/import.js), which runs the first
// before its bottle loop and the second after it. The pure parts (the plan,
// the positions, the check of the reviewed configuration) are in
// utils/rackImport.js.

const Rack = require('../models/Rack');
const { RACK_TYPES } = require('../models/Rack');
const { getMaxPosition, fitCabinetTypeConfig } = require('../utils/rackGeometry');
const { planRackCreations, placeBottlesInRack } = require('../utils/rackImport');
const { logAudit } = require('./audit');

/**
 * Create every rack the import's rows name that the cellar does not have yet.
 * What the user chose in the review (`rackConfigs`, from
 * utils/rackImport.sanitizeRackConfigs) wins over the dimensions the file
 * implies; a rack marked skip is not created. A created rack belongs to the
 * cellar's owner and gets a `rack.create` audit row.
 *
 * Never throws: a rack that cannot be created leaves its bottles unplaced,
 * it does not fail the import. Returns the created racks as
 * [{ name, type, rows, cols, typeConfig }]. Caller: POST /api/bottles/import/confirm.
 */
async function createImportRacks({ req, cellar, cellarId, items, rackConfigs }) {
  const createdRacks = [];
  try {
    const rackPlan = planRackCreations(items);
    if (rackPlan.size > 0) {
      const existing = await Rack.find({
        cellar: cellarId,
        name: { $in: Array.from(rackPlan.keys()) },
        deletedAt: null
      }).select('name').lean();
      const existingNames = new Set(existing.map(r => r.name));

      for (const [name, spec] of rackPlan.entries()) {
        if (existingNames.has(name)) continue;
        const override = rackConfigs[name];
        // User opted out of creating this rack — bottles will be imported
        // into the cellar without placement (handled in the placement loop).
        if (override?.skip) continue;
        const rows = override?.rows || spec.rows;
        const cols = override?.cols || spec.cols;
        const chosenType = override?.type || spec.type;
        const safeType = RACK_TYPES.includes(chosenType) ? chosenType : 'grid';
        const rackData = {
          cellar: cellarId,
          user: cellar.user,
          name,
          type: safeType,
          rows,
          cols
        };
        if (override?.typeConfig) rackData.typeConfig = override.typeConfig;
        // A cabinet is always stored with a list that matches its shelf count:
        // the update route's shape gate would otherwise reject every later
        // rename, group or zone edit.
        if (safeType === 'cabinet') {
          rackData.typeConfig = fitCabinetTypeConfig(rows, cols, rackData.typeConfig);
        }
        const rack = new Rack(rackData);
        // Disabled positions beyond the created geometry address cells that
        // don't exist — drop them rather than storing dead entries.
        if (override?.disabledPositions?.length) {
          const rackMax = getMaxPosition(rack);
          rack.disabledPositions = override.disabledPositions.filter(p => p <= rackMax);
        }
        await rack.save();
        createdRacks.push({ name, type: safeType, rows, cols, typeConfig: override?.typeConfig });
        // cellarId: an editor's import changes the OWNER's cellar, so the
        // owner's caches (offline copy, search, stats) must move too.
        logAudit(req, 'rack.create', { type: 'rack', id: rack._id, cellarId: cellar._id }, { source: 'import', name });
      }
    }
  } catch (err) {
    console.error('Failed to auto-create racks during import (non-fatal):', err.message);
  }
  return createdRacks;
}

/**
 * Place the imported bottles in their racks, one rack at a time, in two
 * passes: each bottle gets the slot its row asks for (for a shelf rack, the
 * first slot of the shelf), then the ones whose slot was taken overflow into
 * the nearest empty slot of the same rack.
 *
 *   pendingPlacements  [{ rackName, item, bottleId, sourceIndex }]
 *   positionAnchor     the corner the file numbers its slots from
 *
 * Never throws: a rack that is missing, full or cannot be saved leaves its
 * bottles in the cellar without a place. Returns { placedCount,
 * overflowedCount, unplacedDetails: [{ sourceIndex, rackName,
 * requestedPosition, reason }] }. Caller: POST /api/bottles/import/confirm.
 */
async function placeImportedBottles({ cellarId, pendingPlacements, positionAnchor }) {
  let placedCount = 0;
  let overflowedCount = 0;
  const unplacedDetails = []; // [{ sourceIndex, rackName, requestedPosition, reason }]
  if (pendingPlacements.length > 0) {
    // Group by rackName
    const byRack = new Map();
    for (const p of pendingPlacements) {
      if (!byRack.has(p.rackName)) byRack.set(p.rackName, []);
      byRack.get(p.rackName).push(p);
    }

    for (const [rackName, group] of byRack.entries()) {
      try {
        const rack = await Rack.findOne({ cellar: cellarId, name: rackName, deletedAt: null });
        if (!rack) {
          for (const p of group) {
            unplacedDetails.push({ sourceIndex: p.sourceIndex, rackName, requestedPosition: null, reason: 'Rack not found' });
          }
          continue;
        }

        const { placements, unplaced } = placeBottlesInRack(
          {
            type: rack.type,
            rows: rack.rows,
            cols: rack.cols,
            // Pass typeConfig as a plain object — for Mongoose subdocs the
            // .toObject() shape is what the helper expects.
            typeConfig: rack.typeConfig?.toObject ? rack.typeConfig.toObject() : rack.typeConfig,
            slots: rack.slots,
            maxPosition: getMaxPosition(rack),
            disabledPositions: rack.disabledPositions
          },
          group,
          positionAnchor
        );

        for (const pl of placements) {
          rack.slots.push({ position: pl.position, bottle: pl.bottle });
        }
        for (const u of unplaced) {
          unplacedDetails.push({ ...u, rackName });
        }

        // Count placements only AFTER the save succeeds: a failed save (a
        // VersionError from a concurrent rack edit, say) must never report
        // bottles as placed that were not stored.
        if (placements.length > 0) {
          try {
            await rack.save();
            for (const pl of placements) {
              placedCount++;
              if (pl.overflowed) overflowedCount++;
            }
          } catch (err) {
            console.error(`Failed to save rack ${rackName} during import:`, err.message);
            for (const pl of placements) {
              const src = group.find(p => String(p.bottleId) === String(pl.bottle));
              unplacedDetails.push({ sourceIndex: src?.sourceIndex ?? null, rackName, requestedPosition: pl.position, reason: `Rack save failed: ${err.message}` });
            }
          }
        }
      } catch (err) {
        console.error(`Failed placement for rack ${rackName}:`, err.message);
        for (const p of group) {
          unplacedDetails.push({ sourceIndex: p.sourceIndex, rackName, requestedPosition: null, reason: err.message });
        }
      }
    }
  }
  return { placedCount, overflowedCount, unplacedDetails };
}

module.exports = { createImportRacks, placeImportedBottles };
