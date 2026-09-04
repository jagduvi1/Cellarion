/**
 * Public key vocabulary + values, user surface (#985 Slice B) — thin HTTP
 * wrappers over services/registryDataOps.js (shared with the MCP tools).
 */
const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const ops = require('../services/registryDataOps');
const { sendServiceFail: sendFail } = require('../utils/serviceResult');

const router = express.Router();

router.use(requireAuth);


/** GET /api/registry-data/keys — the accepted vocabulary. */
router.get('/keys', async (req, res, next) => {
  try {
    const result = await ops.listAcceptedKeys();
    res.json({ keys: result.keys });
  } catch (err) {
    next(err);
  }
});

/** POST /api/registry-data/keys — propose a new key (admin accepts). */
router.post('/keys', requireNonDemo, async (req, res, next) => {
  try {
    const { name, type, unit, enumOptions, rationale } = req.body || {};
    const result = await ops.proposeKey(req.user.id, { name, type, unit, enumOptions, rationale }, { via: 'web', req });
    if (!result.ok) return sendFail(res, result);
    res.status(201).json({ key: result.key });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/registry-data/wine/:id — accepted keys with published values for
 * one wine, plus the caller's own pending suggestions.
 */
router.get('/wine/:id', async (req, res, next) => {
  try {
    // ?vintage=YYYY resolves per-vintage overrides for that bottling and
    // tells the client which slot a new suggestion would land in.
    const vintage = typeof req.query.vintage === 'string' ? req.query.vintage : undefined;
    const result = await ops.dataForWine(req.params.id, req.user.id, { roles: req.user.roles, vintage });
    if (!result.ok) return sendFail(res, result);
    res.json({ fields: result.fields, vintage: result.vintage });
  } catch (err) {
    next(err);
  }
});

/** POST /api/registry-data/wine/:id — suggest a value for an accepted key. */
router.post('/wine/:id', requireNonDemo, async (req, res, next) => {
  try {
    const { keyId, keyName, value, reason, evidenceUrl, vintage } = req.body || {};
    const result = await ops.suggestValue(
      req.user.id,
      { wineId: req.params.id, keyId, keyName, value, reason, evidenceUrl, vintage },
      { via: 'web', req }
    );
    if (!result.ok) return sendFail(res, result);
    res.status(201).json({ value: result.value });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
