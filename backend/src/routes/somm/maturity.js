const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const WineVintageProfile = require('../../models/WineVintageProfile');
const { isValidId } = require('../../utils/validation');
const { parsePagination } = require('../../utils/pagination');
const { logAudit } = require('../../services/audit');

const aiConfig = require('../../config/aiConfig');
const { suggestDrinkWindow } = require('../../services/labelScan');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

const PHASE_FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];

// Parse an optional year field from the request body (returns null if blank/absent)
function parseYear(val) {
  if (val === undefined || val === null || val === '') return null;
  const yr = parseInt(val);
  return isNaN(yr) ? NaN : yr;
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
          select: 'name producer type image country region appellation aiProfile',
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
 * Used by BottleDetail to display maturity status.
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

    const profile = await WineVintageProfile.findOne({
      wineDefinition: String(wine),
      vintage: String(vintage)
    }).populate({ path: 'setBy', select: 'username' });

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

    // Parse all year fields
    // NV wines store the window as year-offsets after each bottle's purchase
    // year (relative), since there's no vintage to anchor absolute years to.
    const isNv = profile.vintage === 'NV';
    const [lo, hi] = isNv ? [0, 100] : [1900, 2200];
    const years = {};
    for (const field of PHASE_FIELDS) {
      const yr = parseYear(req.body[field]);
      if (yr !== null && isNaN(yr)) {
        return res.status(400).json({ error: `Invalid value for ${field}` });
      }
      if (yr !== null && (yr < lo || yr > hi)) {
        return res.status(400).json({ error: isNv ? `${field} must be between 0 and 100 years` : `Year out of range for ${field}` });
      }
      years[field] = yr;
    }

    const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = years;

    // Ordering validations — only check pairs that are both provided.
    // Compare against null, not truthiness: 0 is a legitimate NV offset.
    if (earlyFrom != null && earlyUntil != null && earlyUntil < earlyFrom)
      return res.status(400).json({ error: 'Early "until" must be after early "from"' });
    if (peakFrom  != null && peakUntil  != null && peakUntil  < peakFrom)
      return res.status(400).json({ error: 'Peak "until" must be after peak "from"' });
    if (lateFrom  != null && lateUntil  != null && lateUntil  < lateFrom)
      return res.status(400).json({ error: 'Late "until" must be after late "from"' });
    if (earlyFrom != null && peakFrom   != null && peakFrom   < earlyFrom)
      return res.status(400).json({ error: 'Peak phase cannot start before early phase' });
    if (peakFrom  != null && lateFrom   != null && lateFrom   < peakFrom)
      return res.status(400).json({ error: 'Late phase cannot start before peak phase' });

    // Apply — only update fields that were explicitly sent (null = clear the field)
    for (const field of PHASE_FIELDS) {
      if (req.body[field] !== undefined) {
        profile[field] = years[field] ?? undefined;
      }
    }
    if (req.body.sommNotes !== undefined) {
      // String() coercion: a truthy non-string threw on .trim() → 500.
      profile.sommNotes = req.body.sommNotes ? String(req.body.sommNotes).trim() : '';
    }

    profile.relative = isNv;
    profile.status = 'reviewed';
    profile.setBy  = req.user.id;
    profile.setAt  = new Date();

    await profile.save();
    await profile.populate([
      {
        path: 'wineDefinition',
        select: 'name producer type image country region',
        populate: [
          { path: 'country', select: 'name' },
          { path: 'region', select: 'name' }
        ]
      },
      { path: 'setBy', select: 'username' }
    ]);

    // Shared-data mutation visible to every user of this wine+vintage —
    // audit like the comparable admin mutations do.
    logAudit(req, 'somm.maturity.review',
      { type: 'wine', id: profile.wineDefinition?._id || profile.wineDefinition },
      { vintage: profile.vintage, relative: profile.relative }
    );

    res.json({ profile });
  } catch (error) {
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
    // Cost control (Johan 2026-08-21): the suggestion answers a question the
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
 */
router.delete('/:id/reset', requireSommOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const profile = await WineVintageProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    for (const field of PHASE_FIELDS) {
      profile[field] = undefined;
    }
    profile.sommNotes = '';
    profile.status    = 'pending';
    profile.setBy     = null;
    profile.setAt     = null;

    await profile.save();

    logAudit(req, 'somm.maturity.reset',
      { type: 'wine', id: profile.wineDefinition },
      { vintage: profile.vintage }
    );

    res.json({ profile });
  } catch (error) {
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

    await WineVintageProfile.deleteOne({ _id: profile._id });

    // Shared-data mutation (the pair leaves every curator's queue) — audited
    // like the review it stands in for.
    logAudit(req, 'somm.maturity.remove',
      { type: 'wine', id: profile.wineDefinition },
      { vintage: profile.vintage }
    );

    res.json({ removed: true });
  } catch (error) {
    console.error('Remove maturity profile error:', error);
    res.status(500).json({ error: 'Failed to remove profile' });
  }
});

module.exports = router;
