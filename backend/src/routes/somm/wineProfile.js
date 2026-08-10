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
  RECORD_FIELDS,
  WINE_TYPES,
  GRAPES_MAX,
  GRAPE_NAME_MAX,
  DESCRIPTION_MAX,
  validateProfilePatch,
  resolveGrapeIdsStrict,
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
    // Structural wine-record fields the same PUT can correct (type/grapes).
    recordFields: RECORD_FIELDS,
    wineTypes: WINE_TYPES,
    grapes: { max: GRAPES_MAX, nameMaxLength: GRAPE_NAME_MAX },
    descriptionMaxLength: DESCRIPTION_MAX,
  });
});

/**
 * PUT /api/somm/wine-profile/:wineId
 * Correct a wine's AI-generated tasting profile — and its structural type and
 * grapes (support ticket d4a1aef5). Sommelier/admin only.
 *
 * Field-level: an absent key leaves the field alone, an explicit null clears
 * it. That is deliberate — the ticket asks for the ability to drop prose the
 * curator does not trust while keeping the structured descriptors that are
 * right (and which, unlike the prose, are what the embedding text is built
 * from, so nulling a description costs semantic search nothing).
 *
 * A write that SETS profile values marks the profile curator-sourced, which
 * permanently exempts it from enrichmentJob re-generation in both modes, and
 * stamps profileReviewedAt so the row also leaves the admin low-confidence
 * queue. A write that ONLY clears does neither — the wine stays eligible for
 * re-enrichment (ticket d49ca3af). Type/grape corrections never touch the
 * profile's provenance; grape names resolve against the taxonomy match-only.
 */
router.put('/:wineId', requireSommOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.wineId)) return res.status(400).json({ error: 'Invalid ID' });

    const check = validateProfilePatch(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    if (Array.isArray(check.clean.grapes) && check.clean.grapes.length > 0) {
      const resolved = await resolveGrapeIdsStrict(check.clean.grapes);
      if (!resolved.ok) {
        return res.status(400).json({ error: `Not in the grape taxonomy: ${resolved.unmatched.join(', ')}` });
      }
      check.clean.grapes = resolved.ids;
    }

    const wine = await WineDefinition.findById(req.params.wineId);
    if (!wine) return res.status(404).json({ error: 'Wine not found' });

    const before = snapshotProfile(wine);
    applyProfilePatch(wine, check.clean, req.user.id);
    await wine.save();

    // The structured descriptors feed buildEmbeddingText, so both indexes are
    // now stale. Meili is nudged directly; Qdrant is re-embedded inline —
    // relying on "the next incremental run" was wrong because NO run is
    // scheduled, so a correction stayed invisible to semantic search until a
    // manual job (mirrors enrichmentJob's own post-write re-embed).
    searchService.indexWine(wine._id).catch(() => {});
    require('../../services/embeddingJob').reembedActiveVintages(wine._id).catch(() => {});

    logAudit(req, 'somm.wineProfile.update', { type: 'wine', id: wine._id }, {
      wine: `${wine.producer} — ${wine.name}`,
      fields: Object.keys(check.clean),
      previousSource: before.source,
    });

    res.json({
      message: 'Tasting profile updated',
      aiProfile: wine.aiProfile,
      profileReviewedAt: wine.profileReviewedAt,
      // Additive: present so the panel can reflect record corrections too.
      type: wine.type,
      grapes: wine.grapes,
    });
  } catch (error) {
    console.error('Update wine profile error:', error);
    res.status(500).json({ error: 'Failed to update tasting profile' });
  }
});

module.exports = router;
