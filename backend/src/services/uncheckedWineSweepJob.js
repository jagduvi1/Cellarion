/**
 * Sweep of wines that wait for a curator's check and that nothing points at
 * any more — runs daily via the scheduler.
 *
 * A wine taken from a member's own data (models/WineDefinition
 * .uncheckedIdentity) exists only because that member's bottle had to save.
 * When the bottles are gone — an import redone, a cellar deleted, the bottles
 * removed one by one — the row has no owner left and never became registry
 * content, but it still sits in the curators' queue as work. This removes it.
 *
 * Conservative, through services/registryGc: a wine stays when ANY bottle
 * points at it, when a bottle in someone's "Recently deleted" may still be
 * restored to it, and when anything curated has grown on it. So a wine whose
 * bottles were just deleted is removed only after the trash has let go of
 * them. A wine younger than MIN_AGE_MS is left alone: its import may still be
 * running, with the bottles a moment behind their wines.
 *
 * GDPR: retention with a purpose and a bound — a member's file data that no
 * bottle of theirs uses any more is not kept. Account erasure removes the
 * same rows at once (services/userData/sharedRegistry.js).
 *
 * Bounded per run; the next run picks up the rest. One failing row never
 * stops the sweep.
 */
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { gcOrphanMintedWine } = require('./registryGc');
const { logger } = require('./audit');

const SWEEP_LIMIT = 500;
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove the unchecked wines no bottle points at. Called by the scheduler.
 *
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ candidates: number, removed: number, kept: number, errors: number }>}
 */
async function runUncheckedWineSweep({ now = new Date() } = {}) {
  const result = { candidates: 0, removed: 0, kept: 0, errors: 0 };
  const waiting = await WineDefinition.find({
    uncheckedIdentity: true,
    draft: { $ne: true },
    createdAt: { $lt: new Date(now.getTime() - MIN_AGE_MS) },
  }).select('_id').sort({ createdAt: 1 }).limit(SWEEP_LIMIT).lean();
  if (waiting.length === 0) return result;

  // One read for the whole batch: only the wines no bottle points at go on to
  // the per-wine guards.
  const ids = waiting.map((w) => w._id);
  const held = new Set((await Bottle.distinct('wineDefinition', { wineDefinition: { $in: ids } })).map(String));
  const orphans = ids.filter((id) => !held.has(String(id)));
  result.candidates = orphans.length;

  for (const id of orphans) {
    try {
      const gc = await gcOrphanMintedWine(id, null, { action: 'wine.unchecked_orphan_delete', via: 'sweep' });
      if (gc.removed) result.removed += 1;
      else result.kept += 1;
    } catch (err) {
      result.errors += 1;
      logger.warn({ err: err.message, wineId: String(id) }, '[uncheckedWineSweepJob] could not remove an orphaned wine');
    }
  }
  return result;
}

module.exports = { runUncheckedWineSweep, SWEEP_LIMIT, MIN_AGE_MS };
