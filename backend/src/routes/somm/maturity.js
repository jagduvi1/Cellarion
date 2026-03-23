const express = require('express');
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const WineVintageProfile = require('../../models/WineVintageProfile');

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
 */
router.get('/', requireSommOrAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status === 'pending' || req.query.status === 'reviewed') {
      filter.status = req.query.status;
    }

    const profiles = await WineVintageProfile.find(filter)
      .populate({
        path: 'wineDefinition',
        select: 'name producer type image country region',
        populate: [
          { path: 'country', select: 'name' },
          { path: 'region', select: 'name' }
        ]
      })
      .populate({ path: 'setBy', select: 'username' })
      .sort({ status: 1, createdAt: -1 }); // pending first, then newest

    res.json({ profiles });
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

    const profile = await WineVintageProfile.findOne({
      wineDefinition: wine,
      vintage
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
    const profile = await WineVintageProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Parse all year fields
    const years = {};
    for (const field of PHASE_FIELDS) {
      const yr = parseYear(req.body[field]);
      if (yr !== null && isNaN(yr)) {
        return res.status(400).json({ error: `Invalid year for ${field}` });
      }
      if (yr !== null && (yr < 1900 || yr > 2200)) {
        return res.status(400).json({ error: `Year out of range for ${field}` });
      }
      years[field] = yr;
    }

    const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = years;

    // Ordering validations — only check pairs that are both provided
    if (earlyFrom && earlyUntil && earlyUntil < earlyFrom)
      return res.status(400).json({ error: 'Early "until" must be after early "from"' });
    if (peakFrom  && peakUntil  && peakUntil  < peakFrom)
      return res.status(400).json({ error: 'Peak "until" must be after peak "from"' });
    if (lateFrom  && lateUntil  && lateUntil  < lateFrom)
      return res.status(400).json({ error: 'Late "until" must be after late "from"' });
    if (earlyFrom && peakFrom   && peakFrom   < earlyFrom)
      return res.status(400).json({ error: 'Peak phase cannot start before early phase' });
    if (peakFrom  && lateFrom   && lateFrom   < peakFrom)
      return res.status(400).json({ error: 'Late phase cannot start before peak phase' });

    // Apply — only update fields that were explicitly sent (null = clear the field)
    for (const field of PHASE_FIELDS) {
      if (req.body[field] !== undefined) {
        profile[field] = years[field] ?? undefined;
      }
    }
    if (req.body.sommNotes !== undefined) {
      profile.sommNotes = req.body.sommNotes ? req.body.sommNotes.trim() : '';
    }

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
    res.json({ profile });
  } catch (error) {
    console.error('Reset maturity profile error:', error);
    res.status(500).json({ error: 'Failed to reset profile' });
  }
});

module.exports = router;
