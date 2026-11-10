const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const WineVintageProfile = require('../../models/WineVintageProfile');
const { isValidId } = require('../../utils/validation');
const { parsePagination } = require('../../utils/pagination');
// The curation body shared with the MCP somm tools: the write, the reset and
// the remove, each with its owners' data-version bump and its audit row.
// This route parses input and words the answers.
const maturityOps = require('../../services/maturityOps');

const aiConfig = require('../../config/aiConfig');
const { suggestDrinkWindow } = require('../../services/labelScan');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

const { PHASE_FIELDS } = maturityOps;

// An optional year field of the request body: null when blank or absent, NaN
// when it is not a whole number. The whole value must be the number: a figure
// with a decimal or a trailing word is refused, not cut off at the first
// stray character.
function parseYear(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return Number.isInteger(val) ? val : NaN;
  if (typeof val === 'string' && /^-?\d+$/.test(val.trim())) return parseInt(val.trim(), 10);
  return NaN;
}

// A refused window (maturityOps.checkWindow) in this route's words.
const ORDER_WORDS = {
  'earlyUntil<earlyFrom': 'Early "until" must be after early "from"',
  'peakUntil<peakFrom': 'Peak "until" must be after peak "from"',
  'lateUntil<lateFrom': 'Late "until" must be after late "from"',
  'peakFrom<earlyFrom': 'Peak phase cannot start before early phase',
  'lateFrom<peakFrom': 'Late phase cannot start before peak phase',
};
function windowRefusal(refusal) {
  const { rule, relative, field, value, after } = refusal;
  if (rule === 'range') return relative ? `${field} must be between 0 and 100 years` : `Year out of range for ${field}`;
  if (rule === 'retained') {
    return `The stored ${field} (${value}) is outside ${relative ? 'the 0–100 year offsets an NV wine uses' : 'the years 1900–2200'}: ` +
      'this window still holds values in the other unit. Send all six fields to rewrite it.';
  }
  return ORDER_WORDS[`${field}<${after}`];
}

/**
 * GET /api/somm/maturity
 * List vintage profiles. Somm/admin only.
 * Query: ?status=pending|reviewed  (default: all)
 *        ?limit / ?offset — pagination (default 100, max 500)
 *
 * Paginated + lean: every added/imported bottle seeds a pending profile, so
 * this collection grows one row per wine+vintage forever — unpaginated it
 * deep-populated the whole set into one response per queue visit.
 */
router.get('/', requireSommOrAdmin, async (req, res) => {
  try {
    // Assign literals, not the request value: the status is allowlisted
    // either way, but assigning the literal keeps user input out of the
    // query object entirely (and clears static-analysis taint tracking).
    const filter = {};
    if (req.query.status === 'pending') filter.status = 'pending';
    else if (req.query.status === 'reviewed') filter.status = 'reviewed';
    const { limit, offset } = parsePagination(req.query, { limit: 100, maxLimit: 500 });

    const [profiles, total] = await Promise.all([
      WineVintageProfile.find(filter)
        .populate({
          // aiProfile rides along so a curator can see the generated tasting
          // note next to the drink window they are about to set — the ticket's
          // point being that a somm who spots wrong prose currently works
          // around it silently and the bad data survives. appellation feeds
          // the same judgement (a Vintage Port's style follows from Porto).
          path: 'wineDefinition',
          select: 'name producer type colour image country region appellation aiProfile',
          populate: [
            { path: 'country', select: 'name' },
            { path: 'region', select: 'name' }
          ]
        })
        .populate({ path: 'setBy', select: 'username' })
        .sort({ status: 1, createdAt: -1 }) // pending first, then newest
        .skip(offset)
        .limit(limit)
        .lean(),
      WineVintageProfile.countDocuments(filter),
    ]);

    res.json({ profiles, total, limit, offset });
  } catch (error) {
    console.error('List maturity profiles error:', error);
    res.status(500).json({ error: 'Failed to load profiles' });
  }
});

/**
 * GET /api/somm/maturity/lookup?wine=:wineId&vintage=:vintage
 * Look up the profile for a specific wine+vintage. Any authenticated user.
 * Used by BottleDetail and CellarVintage to display maturity status. Who set
 * the window (setBy) goes to sommeliers and admins only: the registry never
 * shows members who contributed its data.
 */
router.get('/lookup', async (req, res) => {
  try {
    const { wine, vintage } = req.query;
    if (!wine || !vintage) {
      return res.status(400).json({ error: 'wine and vintage query params required' });
    }
    if (!mongoose.isValidObjectId(String(wine))) {
      return res.status(400).json({ error: 'Invalid wine ID' });
    }

    const curator = req.user.roles.includes('somm') || req.user.roles.includes('admin');
    const query = WineVintageProfile.findOne({
      wineDefinition: String(wine),
      vintage: String(vintage)
    });
    const profile = await (curator ? query.populate({ path: 'setBy', select: 'username' }) : query.select('-setBy'));

    if (!profile) {
      return res.json({ profile: null });
    }

    res.json({ profile });
  } catch (error) {
    console.error('Lookup maturity profile error:', error);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

/**
 * PUT /api/somm/maturity/:id
 * Set maturity window values and mark as reviewed. Somm/admin only.
 * Body: { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil, sommNotes }
 */
router.put('/:id', requireSommOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const profile = await WineVintageProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Only the fields explicitly sent change (null or blank = clear the
    // field); a field not sent keeps its stored value.
    const incoming = {};
    for (const field of PHASE_FIELDS) {
      const yr = parseYear(req.body[field]);
      if (Number.isNaN(yr)) {
        return res.status(400).json({ error: `Invalid value for ${field}` });
      }
      incoming[field] = req.body[field] === undefined ? undefined : yr;
    }
    // The window the row would hold AFTER the patch is what is checked: the
    // range (year offsets for NV, years otherwise), stored values the patch
    // keeps, and the ordering across sent and stored values alike. The same
    // check as the MCP set_vintage_maturity (services/maturityOps).
    const checked = maturityOps.checkWindow(profile, incoming);
    if (!checked.ok) {
      return res.status(checked.code === 'conflict' ? 409 : 400).json({ error: windowRefusal(checked) });
    }
    const { next } = checked;
    // String() coercion: a truthy non-string threw on .trim() → 500.
    const sommNotes = req.body.sommNotes !== undefined
      ? (req.body.sommNotes ? String(req.body.sommNotes).trim() : '')
      : undefined;
    if (sommNotes !== undefined && sommNotes.length > maturityOps.SOMM_NOTES_MAX) {
      return res.status(400).json({ error: `Notes too long (max ${maturityOps.SOMM_NOTES_MAX} characters)` });
    }

    // Phases, note, reviewed stamp and relative flag written; the owners'
    // data version moved; audited: the same body as the MCP
    // set_vintage_maturity (services/maturityOps).
    await maturityOps.applyWindow(profile, next, { sommNotes, actorId: req.user.id, req });
    await profile.populate([
      {
        path: 'wineDefinition',
        select: 'name producer type colour image country region',
        populate: [
          { path: 'country', select: 'name' },
          { path: 'region', select: 'name' }
        ]
      },
      { path: 'setBy', select: 'username' }
    ]);

    res.json({ profile });
  } catch (error) {
    // The row was removed from the queue between the load and the save.
    if (error?.name === 'DocumentNotFoundError') {
      return res.status(409).json({ error: 'This vintage was removed from the queue while saving — reload the queue.' });
    }
    console.error('Update maturity profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * POST /api/somm/maturity/:id/ai-suggest
 * Ask AI to suggest drink window phases for this wine+vintage. Somm/admin only.
 * Returns suggested values for the form (not saved until the user confirms).
 */
router.post('/:id/ai-suggest', requireSommOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const profile = await WineVintageProfile.findById(req.params.id)
      .populate({
        path: 'wineDefinition',
        select: 'name producer type country region appellation grapes',
        populate: [
          { path: 'country', select: 'name' },
          { path: 'region', select: 'name' },
          { path: 'grapes', select: 'name' }
        ]
      });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const wine = profile.wineDefinition;
    // Cost control: the suggestion answers a question the
    // curator is already researching by hand, and they work on a flat-rate
    // subscription. 503 rather than a silent empty result, with the reason
    // spelled out so the caller knows to research rather than retry.
    if (!aiConfig.get().sommMaturitySuggestEnabled) {
      return res.status(503).json({
        error: 'AI drink-window suggestions are turned off — set the window from your own research.',
        code: 'suggestion_disabled',
      });
    }
    const result = await suggestDrinkWindow({
      name: wine?.name,
      producer: wine?.producer,
      vintage: profile.vintage,
      country: wine?.country?.name,
      region: wine?.region?.name,
      appellation: wine?.appellation,
      type: wine?.type,
      grapes: wine?.grapes?.map(g => g.name)
    });

    if (!result.data) {
      console.error('[ai-suggest] failed — reason:', result.debugReason, '| raw:', result.debugRaw);
      return res.status(422).json({
        error: 'AI could not suggest a drink window for this wine',
        reason: result.debugReason
      });
    }

    res.json({ suggestion: result.data });
  } catch (error) {
    console.error('AI maturity suggest error:', error);
    res.status(500).json({ error: 'Failed to get AI suggestion' });
  }
});

/**
 * DELETE /api/somm/maturity/:id/reset
 * Reset a reviewed profile back to pending. Somm/admin only.
 * A pending row is refused (409): it has no window to withdraw — the same
 * answer the MCP reset_maturity_row tool gives.
 */
router.delete('/:id/reset', requireSommOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const profile = await WineVintageProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    if (profile.status !== 'reviewed') {
      return res.status(409).json({ error: 'This vintage is already pending — there is no window to withdraw.' });
    }

    // Cleared, pending again, stamp dropped, owners bumped, audited: the same
    // body as the MCP reset_maturity_row (services/maturityOps).
    await maturityOps.resetWindow(profile, { req });

    res.json({ profile });
  } catch (error) {
    if (error?.name === 'DocumentNotFoundError') {
      return res.status(409).json({ error: 'This vintage was removed from the queue while saving — reload the queue.' });
    }
    console.error('Reset maturity profile error:', error);
    res.status(500).json({ error: 'Failed to reset profile' });
  }
});

/**
 * DELETE /api/somm/maturity/:id
 * Remove a wine+vintage from the queue WITHOUT curating it. Somm/admin only.
 *
 * For the pair that cannot be curated at all: the wine was never released in
 * that vintage (a user typed a year it does not have, often while testing).
 * Inventing a window would poison shared data, so the row is deleted outright.
 * Nothing is remembered on purpose — the next time anyone adds a bottle of
 * this wine+vintage, ensurePendingVintageProfile re-seeds the row and it
 * re-enters the queue on the same schedule as every other wine. That IS the
 * comeback mechanism: a bottle add is exactly the signal that the vintage now
 * exists in the real world.
 *
 * A reviewed row is refused: it carries a curated window users already see,
 * and deleting it would silently retire that data. Reset it first — an
 * explicit, separately audited step.
 */
router.delete('/:id', requireSommOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const profile = await WineVintageProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    if (profile.status === 'reviewed') {
      return res.status(409).json({ error: 'This vintage is already reviewed — reset it to pending before removing it.' });
    }

    // Deleted and audited like the review it stands in for: the same body as
    // the MCP remove_from_maturity_queue (services/maturityOps). The delete
    // re-checks the status, so a row reviewed since the load above stays.
    const removed = await maturityOps.removePendingRow(profile, { req });
    if (!removed) {
      return res.status(409).json({ error: 'This vintage was reviewed or removed by someone else just now — reload the queue.' });
    }

    res.json({ removed: true });
  } catch (error) {
    console.error('Remove maturity profile error:', error);
    res.status(500).json({ error: 'Failed to remove profile' });
  }
});

module.exports = router;
