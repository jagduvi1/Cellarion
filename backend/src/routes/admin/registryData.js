/**
 * Admin review of the public key vocabulary + suggested values (#985 Slice B).
 * Mirrors the admin wine-proposals surface: list the queues, decide rows.
 */
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const ops = require('../../services/registryDataOps');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

const CODE_STATUS = { invalid: 400, not_found: 404 };
const sendFail = (res, result) =>
  res.status(CODE_STATUS[result.code] || 400).json({ error: result.message });

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

/** POST /api/admin/registry-data/values/:id/decide  { decision: publish|reject, rejectReason? } */
router.post('/values/:id/decide', async (req, res, next) => {
  try {
    const { decision, rejectReason } = req.body || {};
    const result = await ops.decideValue(req.user.id, req.params.id, decision, rejectReason, { req });
    if (!result.ok) return sendFail(res, result);
    res.json({ value: result.value });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
