const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const McpUsageStat = require('../../models/McpUsageStat');
const McpActionLog = require('../../models/McpActionLog');
const ApiToken = require('../../models/ApiToken');
const rateLimitsConfig = require('../../config/rateLimits');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// Token scopes that mean "this credential can talk to /api/mcp" — climate-only
// device tokens are not AI connections and are excluded from the counts.
const MCP_SCOPES = ['read', 'consume', 'write'];

// GET /api/admin/mcp/usage?days=30 — the admin MCP overview: per-day call/error
// series, top tools, connection counts, recent write volume, kill-switch state.
// Everything here is aggregate (McpUsageStat carries no user reference); the
// only per-user data touched are COUNTS over ApiToken/McpActionLog.
router.get('/usage', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [daily, topTools, connections, writesLast7d] = await Promise.all([
      McpUsageStat.aggregate([
        { $match: { day: { $gte: since } } },
        { $group: {
          _id: { day: '$day', surface: '$surface' },
          calls: { $sum: '$calls' },
          errors: { $sum: '$errorCount' },
        } },
        { $sort: { '_id.day': 1 } },
      ]),
      McpUsageStat.aggregate([
        { $match: { day: { $gte: since }, kind: 'tool' } },
        { $group: {
          _id: { name: '$name', surface: '$surface' },
          calls: { $sum: '$calls' },
          errors: { $sum: '$errorCount' },
        } },
        { $sort: { calls: -1 } },
        { $limit: 20 },
      ]),
      // Live AI connections, split by how they were minted: OAuth connectors
      // carry a refreshTokenHash; hand-minted bearer tokens don't.
      ApiToken.aggregate([
        { $match: { revokedAt: null, scopes: { $in: MCP_SCOPES } } },
        { $group: {
          _id: { $cond: [{ $ifNull: ['$refreshTokenHash', false] }, 'oauth', 'bearer'] },
          total: { $sum: 1 },
          activeLast7d: { $sum: { $cond: [{ $gte: ['$lastUsedAt', weekAgo] }, 1, 0] } },
        } },
      ]),
      // Real (non-preview) writes AIs performed in the last 7 days.
      McpActionLog.countDocuments({
        createdAt: { $gte: weekAgo },
        action: { $nin: ['bulk_preview', 'arrange_preview'] },
      }),
    ]);

    const connOut = { bearer: { total: 0, activeLast7d: 0 }, oauth: { total: 0, activeLast7d: 0 } };
    for (const c of connections) {
      connOut[c._id] = { total: c.total, activeLast7d: c.activeLast7d };
    }

    res.json({
      days,
      daily: daily.map((d) => ({
        day: d._id.day,
        surface: d._id.surface,
        calls: d.calls,
        errors: d.errors,
      })),
      topTools: topTools.map((t) => ({
        name: t._id.name,
        surface: t._id.surface,
        calls: t.calls,
        errors: t.errors,
      })),
      connections: connOut,
      writesLast7d,
      // Current kill-switch state so the page renders toggles without a second
      // round-trip (writes go through PATCH /api/admin/settings/rate-limits).
      mcpConfig: rateLimitsConfig.get().mcp || rateLimitsConfig.defaults.mcp,
    });
  } catch (err) {
    console.error('Admin MCP usage error:', err);
    res.status(500).json({ error: 'Failed to load MCP usage' });
  }
});

module.exports = router;
