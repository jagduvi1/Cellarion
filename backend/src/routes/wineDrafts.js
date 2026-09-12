/**
 * /api/wine-drafts — a creator's PRIVATE DRAFT wines (support ticket
 * 2026-09-12; design on models/WineDefinition.draft). Its own router rather
 * than more paths under /api/wines, whose `/:id` and `/:idOrSlug/*` routes
 * would shadow them.
 *
 *   GET    /             my drafts
 *   GET    /:id          one draft — creator, or a member of a shared cellar
 *                        holding a bottle of it (read only)
 *   PATCH  /:id          edit (creator)
 *   POST   /:id/publish  { confirmCreate? } → 200 published |
 *                        409 duplicate { match } | 409 similar { candidates } |
 *                        400 invalid_identity
 *   POST   /publish      { ids, confirmCreate? } → per-id results
 *   POST   /:id/attach   { targetWineId } → bottles moved onto that wine, draft gone
 *   DELETE /:id          an EMPTY draft (409 when it holds bottles)
 *
 * Every write is the creator's own data; nothing here is shared until
 * publish, which is why none of it goes through the correction queue.
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { isValidId } = require('../utils/validation');
const { findVisibleWine } = require('../services/wineVisibility');
const ops = require('../services/wineDraftOps');

router.use(requireAuth);

const STATUS = { invalid_input: 400, invalid_identity: 400, not_found: 404, conflict: 409, duplicate: 409, similar: 409 };
const sendFail = (res, r) => {
  const { ok, code, message, ...rest } = r; // eslint-disable-line no-unused-vars
  return res.status(STATUS[code] || 400).json({ error: message, code, ...rest });
};

const POPULATE = [
  { path: 'country', select: 'name' },
  { path: 'region', select: 'name' },
  { path: 'grapes', select: 'name' },
];

// GET /api/wine-drafts — my drafts
router.get('/', async (req, res) => {
  try {
    const r = await ops.listDrafts(req.user.id);
    res.json({ drafts: r.drafts });
  } catch (err) {
    console.error('List wine drafts error:', err);
    res.status(500).json({ error: 'Failed to list drafts' });
  }
});

// POST /api/wine-drafts/publish — batch
router.post('/publish', requireNonDemo, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (ids.some((id) => !isValidId(id))) return res.status(400).json({ error: 'ids must be wine ids' });
    const r = await ops.publishDrafts(ids, req.user.id, { req, confirmCreate: req.body?.confirmCreate === true });
    if (!r.ok) return sendFail(res, r);
    res.json({ results: r.results });
  } catch (err) {
    console.error('Batch publish wine drafts error:', err);
    res.status(500).json({ error: 'Failed to publish drafts' });
  }
});

// GET /api/wine-drafts/:id — creator or shared-cellar member (read only)
router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const wine = await findVisibleWine(req.params.id, {
      userId: req.user.id, roles: req.user.roles, viaSharedCellar: true, populate: POPULATE, lean: true,
    });
    if (!wine || wine.draft !== true) return res.status(404).json({ error: 'Draft not found' });
    const mine = String(wine.createdBy) === String(req.user.id);
    res.json({ draft: ops.draftSummary(wine), mine });
  } catch (err) {
    console.error('Get wine draft error:', err);
    res.status(500).json({ error: 'Failed to load draft' });
  }
});

// PATCH /api/wine-drafts/:id — edit (creator only)
router.patch('/:id', requireNonDemo, async (req, res) => {
  try {
    const loaded = await ops.loadOwnDraft(req.params.id, req.user.id);
    if (!loaded.ok) return sendFail(res, loaded);
    const v = ops.validateDraftPatch(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const r = await ops.updateDraft(loaded.wine, v.clean, req.user.id);
    if (!r.ok) return sendFail(res, r);
    const { logAudit } = require('../services/audit');
    logAudit(req, 'wine.draft_edit', { type: 'wine', id: r.wine._id }, { diff: r.diff });
    await r.wine.populate(POPULATE);
    res.json({ draft: ops.draftSummary(r.wine), diff: r.diff });
  } catch (err) {
    console.error('Update wine draft error:', err);
    res.status(500).json({ error: 'Failed to update draft' });
  }
});

// POST /api/wine-drafts/:id/publish
router.post('/:id/publish', requireNonDemo, async (req, res) => {
  try {
    const loaded = await ops.loadOwnDraft(req.params.id, req.user.id);
    if (!loaded.ok) return sendFail(res, loaded);
    const r = await ops.publishDraft(loaded.wine, { userId: req.user.id, req, confirmCreate: req.body?.confirmCreate === true });
    if (!r.ok) return sendFail(res, r);
    await r.wine.populate(POPULATE);
    res.json({
      published: true,
      promoted: r.promoted,
      pendingCuration: r.pendingCuration,
      wine: { _id: r.wine._id, name: r.wine.name, producer: r.wine.producer || null, slug: r.wine.slug || null },
    });
  } catch (err) {
    console.error('Publish wine draft error:', err);
    res.status(500).json({ error: 'Failed to publish draft' });
  }
});

// POST /api/wine-drafts/:id/attach — the bottles go onto an existing wine
router.post('/:id/attach', requireNonDemo, async (req, res) => {
  try {
    const loaded = await ops.loadOwnDraft(req.params.id, req.user.id);
    if (!loaded.ok) return sendFail(res, loaded);
    const targetWineId = String(req.body?.targetWineId || '');
    if (!isValidId(targetWineId)) return res.status(400).json({ error: 'targetWineId must be a wine id' });
    const r = await ops.attachDraftBottles(loaded.wine, targetWineId, { userId: req.user.id, roles: req.user.roles, req });
    if (!r.ok) return sendFail(res, r);
    res.json({ attached: true, bottlesMoved: r.bottlesMoved, wine: { _id: r.wine._id, name: r.wine.name, producer: r.wine.producer || null } });
  } catch (err) {
    console.error('Attach wine draft error:', err);
    res.status(500).json({ error: 'Failed to attach draft' });
  }
});

// DELETE /api/wine-drafts/:id — an empty draft only
router.delete('/:id', requireNonDemo, async (req, res) => {
  try {
    const loaded = await ops.loadOwnDraft(req.params.id, req.user.id);
    if (!loaded.ok) return sendFail(res, loaded);
    const r = await ops.deleteDraft(loaded.wine, req);
    if (!r.ok) return sendFail(res, r);
    res.status(204).end();
  } catch (err) {
    console.error('Delete wine draft error:', err);
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

module.exports = router;
