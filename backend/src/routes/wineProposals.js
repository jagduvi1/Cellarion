/**
 * User-facing wine-correction suggestions (#985 Slice A) — thin HTTP wrappers
 * over services/wineProposalOps.js (shared with the MCP tool
 * suggest_wine_correction). Regular users file field corrections into the
 * SAME admin queue the sommelier flow uses; nothing auto-applies.
 */
const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const ops = require('../services/wineProposalOps');

const router = express.Router();

router.use(requireAuth);

const CODE_STATUS = {
  invalid: 400,
  limit: 429,
  banned: 403,
  not_found: 404,
  conflict: 409,
};

const sendFail = (res, result) =>
  res.status(CODE_STATUS[result.code] || 400).json({ error: result.message });

/**
 * POST /api/wine-proposals
 * Body: { wineId, fields: {producer?…classification?}, reason, evidenceUrl? }
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
    res.status(201).json({
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
 */
router.get('/mine', async (req, res, next) => {
  try {
    const result = await ops.listMineForWine(req.user.id, req.query.wine);
    if (!result.ok) return sendFail(res, result);
    res.json({ proposals: result.proposals });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
