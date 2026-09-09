/**
 * Admin review of the public key vocabulary + suggested values (#985 Slice B).
 * Mirrors the admin wine-proposals surface: list the queues, decide rows.
 */
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const ops = require('../../services/registryDataOps');
const { sendServiceFail: sendFail } = require('../../utils/serviceResult');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));


/** GET /api/admin/registry-data — both review queues. */
router.get('/', async (req, res, next) => {
  try {
    const result = await ops.listReviewQueues();
    res.json({ keys: result.keys, values: result.values });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/registry-data/keys/:id/decide  { decision: accept|reject, rejectReason? } */
router.post('/keys/:id/decide', async (req, res, next) => {
  try {
    const { decision, rejectReason } = req.body || {};
    const result = await ops.decideKey(req.user.id, req.params.id, decision, rejectReason, { req });
    if (!result.ok) return sendFail(res, result);
    res.json({ key: result.key });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/registry-data/values/:id/decide
 *   { decision: publish|reject, rejectReason?, asWineDefault? }
 * asWineDefault publishes a vintage-specific suggestion as the wine-wide
 * default instead (the reviewer judged the evidence to be a producer spec).
 */
router.post('/values/:id/decide', async (req, res, next) => {
  try {
    const { decision, rejectReason, asWineDefault } = req.body || {};
    const result = await ops.decideValue(req.user.id, req.params.id, decision, rejectReason, {
      req, asWineDefault: asWineDefault === true,
    });
    if (!result.ok) return sendFail(res, result);
    res.json({ value: result.value });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/registry-data/keys/:id/translations
 * Body: { translations: { de: "Alkoholgehalt", fr: "Degré d'alcool" } }
 *
 * A full replacement: a language absent from the body is removed. Mirrors
 * PUT /api/admin/taxonomy/:kind/:id/translations.
 */
router.put('/keys/:id/translations', async (req, res, next) => {
  try {
    const result = await ops.setKeyTranslations(req.user.id, req.params.id, req.body?.translations, { req });
    if (!result.ok) return sendFail(res, result);
    res.json({ key: result.key });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
