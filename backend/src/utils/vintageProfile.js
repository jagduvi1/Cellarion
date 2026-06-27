const WineVintageProfile = require('../models/WineVintageProfile');

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
    await WineVintageProfile.findOneAndUpdate(
      { wineDefinition: wineDefinitionId, vintage },
      { $setOnInsert: { wineDefinition: wineDefinitionId, vintage, status: 'pending' } },
      { upsert: true, new: false }
    );
  } catch (err) {
    // Non-fatal: the bottle/wine already saved — the queue entry is best-effort.
    console.warn('ensurePendingVintageProfile failed (non-fatal):', err.message);
  }
}

module.exports = { ensurePendingVintageProfile };
