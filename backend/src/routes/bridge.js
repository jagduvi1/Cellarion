const express = require('express');
const router = express.Router();
const { requireAuth, requireNonDemo, requireRole } = require('../middleware/auth');
const { logAudit, logger } = require('../services/audit');
const bridge = require('../services/registryBridge');
const { decorateGrapes } = require('../utils/grapeDisplay');
const contributions = require('../services/registryContributionOps');
const { findVisibleWine } = require('../services/wineVisibility');
const { isValidId } = require('../utils/validation');
const asyncHandler = require('../utils/asyncHandler');

// Registry Bridge — the SELF-HOSTED side's own routes (the hosted side is
// /api/bridge/keys and /api/bridge/v1). Any signed-in user of this install
// can see whether it is connected and adopt a registry wine into it; the
// key itself lives in the server's .env and never reaches the browser.

const ADOPT_STATUS = { disabled: 404, invalid: 400, not_found: 404, unavailable: 503, conflict: 409 };
const ADOPT_MESSAGE = {
  disabled: 'This install is not connected to the shared registry.',
  invalid: 'Invalid registry wine id.',
  not_found: 'That wine is no longer in the shared registry.',
  unavailable: 'The shared registry could not be reached right now — try again in a minute, or add the wine by hand.',
  conflict: 'A wine with this identity here is already linked to a different registry wine — an admin can merge or correct it.',
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
    // An answer about the copy, like a creation answer: no sweetness style,
    // whether or not the copy was loaded with it (GET /api/wines/:id has it).
    const wine = decorateGrapes(r.wine);
    delete wine.sweetnessStyle;
    res.status(r.created ? 201 : 200).json({ wine, created: r.created });
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

// ── Contributions: wines made on this install offered to the shared registry
// (services/registryContributionOps). Offering and taking back are for this
// install's admins: a contribution goes up under the key owner's account and
// spends the key's daily allowance.

const NOT_CONNECTED = { error: ADOPT_MESSAGE.disabled, code: 'disabled' };

// GET /api/bridge/contributions — never offered, by state, and the ones that
// need a person (declined, duplicate, failed). Admins.
router.get('/contributions', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  res.json(await contributions.contributionOverview());
}));

// GET /api/bridge/contributions/:wineId — one wine's state, for its page.
// { enabled: false } when this install is not connected.
router.get('/contributions/:wineId', requireAuth, asyncHandler(async (req, res) => {
  const { wineId } = req.params;
  if (!isValidId(wineId)) return res.status(400).json({ error: 'Invalid wine id.', code: 'invalid' });
  const visible = await findVisibleWine(wineId, { userId: req.user.id, roles: req.user.roles, select: '_id', lean: true });
  if (!visible) return res.status(404).json({ error: 'Wine not found.', code: 'not_found' });
  const state = await contributions.contributionForWine(wineId);
  if (!state) return res.status(404).json({ error: 'Wine not found.', code: 'not_found' });
  res.json(state);
}));

// POST /api/bridge/contributions { wineIds: [...] } | { all: true } — offer
// wines. One wine is sent at once, so its page can say so; more are sent
// after the answer, and the hourly job carries on where the day's allowance
// stops. 202 when anything was queued.
router.post('/contributions', requireAuth, requireNonDemo, requireRole('admin'), asyncHandler(async (req, res) => {
  const all = req.body?.all === true;
  const r = await contributions.queueContributions({ wineIds: req.body?.wineIds, all, req, via: 'web' });
  if (!r.ok && r.code === 'disabled') return res.status(404).json(NOT_CONNECTED);
  if (!r.ok) return res.status(400).json({ error: `wineIds must be 1–${contributions.QUEUE_MAX} wine ids`, code: 'invalid' });
  if (r.queued === 1 && !all) {
    await contributions.sendQueued({ max: 1, ids: r.ids });
  } else if (r.queued) {
    contributions.sendQueued().catch((err) => logger.warn({ err }, '[bridge] contribution send after queueing failed'));
  }
  const wine = r.queued === 1 && !all ? await contributions.contributionForWine(r.ids[0]) : null;
  res.status(r.queued ? 202 : 200).json({ queued: r.queued, ...(wine ? { wine } : {}) });
}));

// DELETE /api/bridge/contributions/:wineId — take back an offer nothing on
// cellarion.app is waiting on (queued, declined, duplicate, failed).
const WITHDRAW_STATUS = { invalid: 400, not_found: 404, sent: 409 };
const WITHDRAW_MESSAGE = {
  invalid: 'Invalid wine id.',
  not_found: 'This wine has not been offered to the shared registry.',
  sent: 'This wine is already with the shared registry; it is answered there.',
};
router.delete('/contributions/:wineId', requireAuth, requireNonDemo, requireRole('admin'), asyncHandler(async (req, res) => {
  const r = await contributions.withdrawContribution({ wineId: req.params.wineId, req, via: 'web' });
  if (!r.ok) return res.status(WITHDRAW_STATUS[r.code] || 400).json({ error: WITHDRAW_MESSAGE[r.code] || 'Failed', code: r.code });
  res.json({ ok: true });
}));

module.exports = router;
