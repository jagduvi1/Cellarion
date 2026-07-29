const express = require('express');
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const WineDefinition = require('../../models/WineDefinition');
const { isValidId } = require('../../utils/validation');
const { logAudit } = require('../../services/audit');
const searchService = require('../../services/search');
const {
  PROFILE_ENUMS,
  LIST_FIELDS,
  EDITABLE_FIELDS,
  DESCRIPTION_MAX,
  validateProfilePatch,
  applyProfilePatch,
  snapshotProfile,
} = require('../../services/wineProfileOps');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/somm/wine-profile/schema
 * The allowed values, so the UI's pickers and any MCP client describe the same
 * vocabulary the validator enforces instead of hardcoding a second copy.
 */
router.get('/schema', requireSommOrAdmin, (req, res) => {
  res.json({
    enums: PROFILE_ENUMS,
    lists: LIST_FIELDS,
    editableFields: EDITABLE_FIELDS,
    descriptionMaxLength: DESCRIPTION_MAX,
  });
});

/**
 * PUT /api/somm/wine-profile/:wineId
 * Correct a wine's AI-generated tasting profile. Sommelier/admin only.
 *
 * Field-level: an absent key leaves the field alone, an explicit null clears
 * it. That is deliberate — the ticket asks for the ability to drop prose the
 * curator does not trust while keeping the structured descriptors that are
 * right (and which, unlike the prose, are what the embedding text is built
 * from, so nulling a description costs semantic search nothing).
 *
 * Writing marks the profile curator-sourced, which permanently exempts it from
 * enrichmentJob re-generation in both modes, and stamps profileReviewedAt so
 * the row also leaves the admin low-confidence queue.
 */
router.put('/:wineId', requireSommOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.wineId)) return res.status(400).json({ error: 'Invalid ID' });

    const check = validateProfilePatch(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const wine = await WineDefinition.findById(req.params.wineId);
    if (!wine) return res.status(404).json({ error: 'Wine not found' });

    const before = snapshotProfile(wine);
    applyProfilePatch(wine, check.clean, req.user.id);
    await wine.save();

    // The structured descriptors feed buildEmbeddingText, so the embedding is
    // now stale. It is textHash-keyed, so the next incremental embedding run
    // picks this up by itself — no explicit invalidation needed. Meili does
    // need a nudge, since it carries the profile fields for filtering.
    searchService.indexWine(wine._id).catch(() => {});

    logAudit(req, 'somm.wineProfile.update', { type: 'wine', id: wine._id }, {
      wine: `${wine.producer} — ${wine.name}`,
      fields: Object.keys(check.clean),
      previousSource: before.source,
    });

    res.json({
      message: 'Tasting profile updated',
      aiProfile: wine.aiProfile,
      profileReviewedAt: wine.profileReviewedAt,
    });
  } catch (error) {
    console.error('Update wine profile error:', error);
    res.status(500).json({ error: 'Failed to update tasting profile' });
  }
});

module.exports = router;
