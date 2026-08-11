const WineVintageProfile = require('../models/WineVintageProfile');
const WineDefinition = require('../models/WineDefinition');

/**
 * Ensure a *pending* WineVintageProfile exists for a (wine, vintage) pair so the
 * wine surfaces in the sommelier maturity queue.
 *
 * Adding a bottle should put its wine+vintage in front of a somm to set a drink
 * window. The hand-add path (routes/bottles.js) does this for every bottle; the
 * import paths must call this too, otherwise wines that arrive via an import —
 * especially ones created from a "request" that an admin later approves — never
 * enter the queue.
 *
 * Behaviour:
 *   - No-op for the 'Unknown' vintage: there is no calendar year to recommend a
 *     window for. NV *does* get a profile so somms can attach drinking notes to
 *     non-vintage Champagne and sparkling blends.
 *   - No-op for a nonWine-quarantined wine. This completes the quarantine:
 *     the non-wine flag hides the row from search and the admin scan pools,
 *     but every re-added bottle of a quarantined cider kept re-seeding a
 *     pending profile and dragging it back into the somm queue.
 *   - NV seeds with relative:true from the start. The flag is fully determined
 *     by the vintage string, and leaving it to default false shipped every NV
 *     wine into the maturity queue in a self-contradictory state — a curator
 *     who did not notice would write absolute calendar years against a wine
 *     with no vintage to anchor them to (support ticket d49d2b36: three
 *     instances from three unrelated entry paths).
 *   - Idempotent: an existing profile (pending OR reviewed) is left untouched
 *     thanks to $setOnInsert, so it never downgrades curated maturity data.
 *   - Non-throwing: any failure (including a unique-index race on concurrent
 *     inserts) is logged and swallowed — seeding the queue is best-effort
 *     relative to the bottle/wine write that triggered it.
 *
 * @param {import('mongoose').Types.ObjectId|string} wineDefinitionId
 * @param {string} vintage  canonical vintage ('2018', 'NV', 'Unknown', …)
 * @returns {Promise<void>}
 */
async function ensurePendingVintageProfile(wineDefinitionId, vintage) {
  if (!wineDefinitionId || !vintage || vintage === 'Unknown') return;
  try {
    // Quarantined non-wines AND pending-identity rows stay out of the somm
    // maturity queue. For a pending row the reason is the same shape as the
    // nonWine one: there is nothing a curator can set a drink window against
    // until the wine has an identity — and it would double-surface the row in
    // two queues. The pending-wines queue is where it belongs; promotion
    // re-seeds the maturity rows from the wine's own bottles.
    if (await WineDefinition.exists({
      _id: wineDefinitionId,
      $or: [{ nonWine: true }, { pendingIdentity: true }],
    })) return;
    await WineVintageProfile.findOneAndUpdate(
      { wineDefinition: wineDefinitionId, vintage },
      { $setOnInsert: { wineDefinition: wineDefinitionId, vintage, status: 'pending', relative: vintage === 'NV' } },
      { upsert: true, new: false }
    );
  } catch (err) {
    // Non-fatal: the bottle/wine already saved — the queue entry is best-effort.
    console.warn('ensurePendingVintageProfile failed (non-fatal):', err.message);
  }
}

module.exports = { ensurePendingVintageProfile };
