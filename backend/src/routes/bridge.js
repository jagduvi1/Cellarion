const express = require('express');
const router = express.Router();
const { requireAuth, requireNonDemo, requireRole } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const bridge = require('../services/registryBridge');
const { decorateGrapes } = require('../utils/grapeDisplay');

// Registry Bridge — the SELF-HOSTED side's own routes (the hosted side is
// /api/bridge/keys and /api/bridge/v1). Any signed-in user of this install
// can see whether it is connected and adopt a registry wine into it; the
// key itself lives in the server's .env and never reaches the browser.

const ADOPT_STATUS = { disabled: 404, invalid: 400, not_found: 404, unavailable: 503 };
const ADOPT_MESSAGE = {
  disabled: 'This install is not connected to the shared registry.',
  invalid: 'Invalid registry wine id.',
  not_found: 'That wine is no longer in the shared registry.',
  unavailable: 'The shared registry could not be reached right now — try again in a minute, or add the wine by hand.',
};

// GET /api/bridge/status — connection state, quota use, held copies.
router.get('/status', requireAuth, async (req, res) => {
  try {
    res.json(await bridge.status());
  } catch (error) {
    console.error('Bridge status error:', error);
    res.status(500).json({ error: 'Failed to read the bridge status' });
  }
});

// POST /api/bridge/adopt { registryId } — copy one registry wine into this
// install and return it as a normal local wine (201 created, 200 already held).
router.post('/adopt', requireAuth, requireNonDemo, async (req, res) => {
  const registryId = req.body?.registryId;
  try {
    const r = await bridge.adoptWine(registryId, req.user.id);
    if (!r.ok) return res.status(ADOPT_STATUS[r.code] || 500).json({ error: ADOPT_MESSAGE[r.code] || 'Adoption failed', code: r.code });
    if (r.created) {
      logAudit(req, 'wine.adopt_registry', { type: 'wine', id: r.wine._id }, { registryId: String(registryId), name: r.wine.name, producer: r.wine.producer });
    }
    res.status(r.created ? 201 : 200).json({ wine: decorateGrapes(r.wine), created: r.created });
  } catch (error) {
    console.error('Bridge adopt error:', error);
    res.status(500).json({ error: 'Failed to copy the wine from the shared registry' });
  }
});

// PATCH /api/bridge/refresh { mode: 'weekly' | 'off' } — the install-wide
// switch for the weekly refresh of copied wines. Admins of this install only;
// refused with env_override while REGISTRY_BRIDGE_REFRESH in .env decides.
router.patch('/refresh', requireAuth, requireRole('admin'), async (req, res) => {
  const mode = req.body?.mode;
  try {
    const r = await bridge.setRefreshMode(mode, req.user.id);
    if (!r.ok && r.code === 'invalid') {
      return res.status(400).json({ error: 'mode must be "weekly" or "off"', code: 'invalid' });
    }
    if (!r.ok && r.code === 'env_override') {
      return res.status(409).json({
        error: 'REGISTRY_BRIDGE_REFRESH is set in this server\'s .env; change it there and restart the backend.',
        code: 'env_override',
        mode: r.mode,
        source: 'env',
      });
    }
    logAudit(req, 'bridge.refresh_mode.update', {}, { mode });
    res.json({ mode: r.mode, source: r.source });
  } catch (error) {
    console.error('Bridge refresh mode error:', error);
    res.status(500).json({ error: 'Failed to update the refresh setting' });
  }
});

module.exports = router;
