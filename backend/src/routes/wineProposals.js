/**
 * User-facing wine-correction suggestions (#985 Slice A) — thin HTTP wrappers
 * over services/wineProposalOps.js (shared with the MCP tool
 * suggest_wine_correction). Regular users file field corrections into the
 * SAME admin queue the sommelier flow uses; nothing auto-applies.
 */
const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const ops = require('../services/wineProposalOps');
const { sendServiceFail: sendFail } = require('../utils/serviceResult');
const registryBridge = require('../services/registryBridge');

const router = express.Router();

router.use(requireAuth);


/**
 * POST /api/wine-proposals
 * Body: { wineId, fields: {producer?…classification?, type?, grapes?[], newGrapes?[]}, reason, evidenceUrl? }
 * `grapes` is the COMPLETE corrected list; `newGrapes` names the entries in it
 * the user deliberately added as a variety the taxonomy does not have yet.
 */
router.post('/', requireNonDemo, async (req, res, next) => {
  try {
    const { wineId, fields, reason, evidenceUrl } = req.body || {};
    const result = await ops.createFieldCorrection(
      req.user.id,
      { wineId, fields, reason, evidenceUrl },
      { via: 'web', req }
    );
    if (!result.ok) return sendFail(res, result);
    // Registry Bridge (self-hosted installs): a correction on a wine copied
    // from the shared registry also goes to the hosted queue, credited to
    // this install's key. Fire-and-forget — the local proposal stands alone.
    registryBridge.forwardCorrection(result.wine, { fields, reason, evidenceUrl }).catch(() => {});
    // 201 for a new queue row; 200 when the caller's own pending suggestion
    // absorbed these fields instead (support ticket 2026-09-12).
    res.status(result.amended ? 200 : 201).json({
      amended: !!result.amended,
      proposal: {
        _id: result.proposal._id,
        proposedFields: result.proposal.proposedFields,
        status: result.proposal.status,
        createdAt: result.proposal.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/wine-proposals/mine?wine=<wineId>
 * The caller's own suggestions on one wine — powers the pending/outcome UI.
 * `pending` is the wine's ONE review slot as this viewer may know it: which
 * fields it covers and whether it is theirs, never whose it is otherwise — so
 * the page can say "someone else's suggestion is waiting" before a correction
 * is typed instead of after (the slot is per wine, across all users).
 */
router.get('/mine', async (req, res, next) => {
  try {
    const result = await ops.listMineForWine(req.user.id, req.query.wine);
    if (!result.ok) return sendFail(res, result);
    const pending = await ops.pendingForViewer(req.user.id, req.query.wine, req.user.roles || []);
    res.json({ proposals: result.proposals, pending });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
