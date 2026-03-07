const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/superAdmin');
const User = require('../models/User');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const Cellar = require('../models/Cellar');
const AuditLog = require('../models/AuditLog');
const BottleImage = require('../models/BottleImage');
const WineRequest = require('../models/WineRequest');
const Rack = require('../models/Rack');

const router = express.Router();

// All super admin routes require auth + super admin check
router.use(requireAuth, requireSuperAdmin);

// ---------------------------------------------------------------------------
// GET /api/superadmin/overview
// Platform-wide aggregate counts, user breakdown, recent registrations
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const [
      totalUsers,
      totalBottles,
      activeBottles,
      consumedBottles,
      totalWines,
      totalCellars,
      totalImages,
      totalRequests,
      totalRacks,
      recentUsers,
      byPlanRaw,
      byRoleRaw,
    ] = await Promise.all([
      User.countDocuments(),
      Bottle.countDocuments(),
      Bottle.countDocuments({ status: { $nin: ['drank', 'gifted', 'sold', 'other'] } }),
      Bottle.countDocuments({ status: { $in: ['drank', 'gifted', 'sold', 'other'] } }),
      WineDefinition.countDocuments(),
      Cellar.countDocuments({ deletedAt: null }),
      BottleImage.countDocuments(),
      WineRequest.countDocuments(),
      Rack.countDocuments(),
      User.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .select('username email roles plan createdAt emailVerified')
        .lean(),
      User.aggregate([{ $group: { _id: '$plan', count: { $sum: 1 } } }]),
      User.aggregate([
        { $unwind: '$roles' },
        { $group: { _id: '$roles', count: { $sum: 1 } } },
      ]),
    ]);

    // Registrations per month — last 12 months
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const registrationsOverTime = await User.aggregate([
      { $match: { createdAt: { $gte: twelveMonthsAgo } } },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const byPlan = Object.fromEntries(byPlanRaw.map(d => [d._id || 'free', d.count]));
    const byRole = Object.fromEntries(byRoleRaw.map(d => [d._id, d.count]));

    res.json({
      counts: {
        totalUsers,
        totalBottles,
        activeBottles,
        consumedBottles,
        totalWines,
        totalCellars,
        totalImages,
        totalRequests,
        totalRacks,
      },
      byPlan,
      byRole,
      registrationsOverTime,
      recentUsers,
    });
  } catch (error) {
    console.error('[superadmin] overview error:', error);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/superadmin/mongodb
// Per-collection document counts, sizes, index info
// ---------------------------------------------------------------------------
router.get('/mongodb', async (req, res) => {
  try {
    const db = mongoose.connection.db;

    const [dbStats, rawCollections] = await Promise.all([
      db.stats(),
      db.listCollections().toArray(),
    ]);

    const collectionStats = await Promise.all(
      rawCollections.map(async (col) => {
        try {
          const stats = await db.collection(col.name).stats();
          return {
            name: col.name,
            count: stats.count ?? 0,
            size: stats.size ?? 0,
            storageSize: stats.storageSize ?? 0,
            avgObjSize: stats.avgObjSize ?? 0,
            totalIndexSize: stats.totalIndexSize ?? 0,
            nindexes: stats.nindexes ?? 0,
          };
        } catch {
          return { name: col.name, count: 0, size: 0, storageSize: 0, avgObjSize: 0, totalIndexSize: 0, nindexes: 0 };
        }
      })
    );

    collectionStats.sort((a, b) => b.count - a.count);

    res.json({
      database: dbStats.db,
      dataSize: dbStats.dataSize,
      storageSize: dbStats.storageSize,
      indexSize: dbStats.indexSize,
      collections: dbStats.collections,
      objects: dbStats.objects,
      avgObjSize: dbStats.avgObjSize ?? 0,
      collectionStats,
    });
  } catch (error) {
    console.error('[superadmin] mongodb error:', error);
    res.status(500).json({ error: 'Failed to load MongoDB stats' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/superadmin/services
// Health and latency for all external services
// ---------------------------------------------------------------------------
router.get('/services', async (req, res) => {
  const results = {};

  // MongoDB
  try {
    const t0 = Date.now();
    const ping = await mongoose.connection.db.admin().ping();
    results.mongodb = { status: ping.ok === 1 ? 'ok' : 'error', latencyMs: Date.now() - t0 };
  } catch (e) {
    results.mongodb = { status: 'error', error: e.message };
  }

  // Meilisearch health
  try {
    const meiliUrl = process.env.MEILI_URL || 'http://meilisearch:7700';
    const t0 = Date.now();
    const meiliRes = await fetch(`${meiliUrl}/health`, {
      headers: { Authorization: `Bearer ${process.env.MEILI_MASTER_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    const data = await meiliRes.json();
    results.meilisearch = { status: data.status || 'unknown', latencyMs };
  } catch (e) {
    results.meilisearch = { status: 'error', error: e.message };
  }

  // Meilisearch stats (index info)
  try {
    const meiliUrl = process.env.MEILI_URL || 'http://meilisearch:7700';
    const statsRes = await fetch(`${meiliUrl}/stats`, {
      headers: { Authorization: `Bearer ${process.env.MEILI_MASTER_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    const stats = await statsRes.json();
    results.meilisearchStats = stats;
  } catch {
    results.meilisearchStats = null;
  }

  // rembg
  try {
    const rembgUrl = process.env.REMBG_URL || 'http://rembg:5000';
    const t0 = Date.now();
    const rembgRes = await fetch(`${rembgUrl}/health`, { signal: AbortSignal.timeout(5000) });
    results.rembg = { status: rembgRes.ok ? 'ok' : 'error', latencyMs: Date.now() - t0 };
  } catch (e) {
    results.rembg = { status: 'error', error: e.message };
  }

  // Anthropic API
  results.anthropic = {
    configured: !!process.env.ANTHROPIC_API_KEY,
    keyPrefix: process.env.ANTHROPIC_API_KEY
      ? `${process.env.ANTHROPIC_API_KEY.substring(0, 14)}...`
      : null,
  };

  // Qdrant (optional)
  if (process.env.QDRANT_URL) {
    try {
      const t0 = Date.now();
      const qdrantRes = await fetch(`${process.env.QDRANT_URL}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - t0;
      results.qdrant = { status: qdrantRes.ok ? 'ok' : 'error', latencyMs, url: process.env.QDRANT_URL };
    } catch (e) {
      results.qdrant = { status: 'error', error: e.message, url: process.env.QDRANT_URL };
    }
  } else {
    results.qdrant = { status: 'not_configured' };
  }

  // Mailgun (configured?)
  results.mailgun = {
    configured: !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN),
    domain: process.env.MAILGUN_DOMAIN || null,
    from: process.env.MAILGUN_FROM || null,
  };

  res.json(results);
});

// ---------------------------------------------------------------------------
// GET /api/superadmin/process
// Node.js process stats
// ---------------------------------------------------------------------------
router.get('/process', (req, res) => {
  const mem = process.memoryUsage();
  const uptimeSec = process.uptime();
  const d = Math.floor(uptimeSec / 86400);
  const h = Math.floor((uptimeSec % 86400) / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = Math.floor(uptimeSec % 60);

  res.json({
    nodeVersion: process.version,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: uptimeSec,
    uptimeFormatted: `${d}d ${h}h ${m}m ${s}s`,
    memory: {
      rssBytes: mem.rss,
      heapTotalBytes: mem.heapTotal,
      heapUsedBytes: mem.heapUsed,
      externalBytes: mem.external,
      heapUsedPct: Math.round((mem.heapUsed / mem.heapTotal) * 100),
    },
    env: {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: process.env.PORT || 5000,
      frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/superadmin/audit?limit=100&action=<filter>
// Full audit log access (all users, all actions)
// ---------------------------------------------------------------------------
router.get('/audit', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const filter = {};
    if (req.query.action) {
      const escaped = req.query.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.action = new RegExp(escaped, 'i');
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .populate({ path: 'actor.userId', select: 'username email', model: 'User' })
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({ logs, total, limit, offset });
  } catch (error) {
    console.error('[superadmin] audit error:', error);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/superadmin/users?limit=200&offset=0&search=
// All users with full details (no pagination limits enforced — super admin only)
// ---------------------------------------------------------------------------
router.get('/users', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const filter = {};

    if (req.query.search) {
      const escaped = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'i');
      filter.$or = [{ username: re }, { email: re }];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('username email roles plan planStartedAt planExpiresAt trialEligible createdAt emailVerified')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({ users, total, limit, offset });
  } catch (error) {
    console.error('[superadmin] users error:', error);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

module.exports = router;
