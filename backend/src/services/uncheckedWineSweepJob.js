/**
 * Sweep of wines that wait for a curator's check and that nothing points at
 * any more — runs daily via the scheduler.
 *
 * A wine taken from a member's own data (models/WineDefinition
 * .uncheckedIdentity) exists only because that member's bottle had to save.
 * When the bottles are gone — an import redone, a cellar deleted, the bottles
 * removed one by one — and nothing else of a member's points at it, the row
 * has no owner left and never became registry content, but it still sits in
 * the curators' queue as work. This removes it.
 *
 * Conservative, through services/registryGc: a wine stays when ANY bottle
 * points at it, when a bottle in someone's "Recently deleted" may still be
 * restored to it, when a wishlist item, a review or other member content
 * points at it (an import to the wishlist creates wines with no bottle), and
 * when anything curated has grown on it. So a wine whose
 * bottles were just deleted is removed only after the trash has let go of
 * them. A wine younger than MIN_AGE_MS is left alone: its import may still be
 * running, with the bottles a moment behind their wines.
 *
 * GDPR: retention with a purpose and a bound — a member's file data that no
 * bottle of theirs uses any more is not kept. Account erasure removes the
 * same rows at once (services/userData/sharedRegistry.js).
 *
 * One failing row never stops the sweep.
 */
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { gcOrphanMintedWine } = require('./registryGc');
const { logger } = require('./audit');

const PAGE_SIZE = 500;
// A run stops after this many removals; the next run goes on. Reads are ids
// only, so examining the whole queue is cheap.
const MAX_REMOVED = 2000;
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove the unchecked wines nothing points at. Called by the scheduler.
 * Walks every waiting wine by _id, a page at a time: a queue full of wines
 * that ARE held must not keep the ones behind them from being looked at.
 *
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ examined: number, candidates: number, removed: number, kept: number, errors: number }>}
 */
async function runUncheckedWineSweep({ now = new Date() } = {}) {
  const result = { examined: 0, candidates: 0, removed: 0, kept: 0, errors: 0 };
  const olderThan = new Date(now.getTime() - MIN_AGE_MS);
  let after = null;
  while (result.removed < MAX_REMOVED) {
    const page = await WineDefinition.find({
      uncheckedIdentity: true,
      draft: { $ne: true },
      createdAt: { $lt: olderThan },
      ...(after ? { _id: { $gt: after } } : {}),
    }).select('_id').sort({ _id: 1 }).limit(PAGE_SIZE).lean();
    if (page.length === 0) break;
    after = page[page.length - 1]._id;
    result.examined += page.length;

    // One read per page: only the wines no bottle points at go on to the
    // per-wine guards (services/registryGc), which also keep a wine with a
    // wishlist item, a review or any other member content on it.
    const ids = page.map((w) => w._id);
    const held = new Set((await Bottle.distinct('wineDefinition', { wineDefinition: { $in: ids } })).map(String));
    const orphans = ids.filter((id) => !held.has(String(id)));
    result.candidates += orphans.length;

    for (const id of orphans) {
      try {
        const gc = await gcOrphanMintedWine(id, null, {
          action: 'wine.unchecked_orphan_delete', via: 'sweep',
          // Still waiting when it is deleted: a wine a curator published a
          // moment ago is registry content, bottles or not.
          onlyIf: { uncheckedIdentity: true },
        });
        if (gc.removed) result.removed += 1;
        else result.kept += 1;
      } catch (err) {
        result.errors += 1;
        logger.warn({ err: err.message, wineId: String(id) }, '[uncheckedWineSweepJob] could not remove an orphaned wine');
      }
    }
    if (page.length < PAGE_SIZE) break;
  }
  return result;
}

module.exports = { runUncheckedWineSweep, PAGE_SIZE, MAX_REMOVED, MIN_AGE_MS };
