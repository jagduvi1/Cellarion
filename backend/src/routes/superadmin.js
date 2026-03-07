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
const WineEmbedding = require('../models/WineEmbedding');
const ChatUsage = require('../models/ChatUsage');
const embeddingJob = require('../services/embeddingJob');
const vectorStore = require('../services/vectorStore');
const aiConfig = require('../config/aiConfig');

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
      db.command({ dbStats: 1 }),
      db.listCollections().toArray(),
    ]);

    const collectionStats = await Promise.all(
      rawCollections.map(async (col) => {
        try {
          const stats = await db.command({ collStats: col.name });
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

  // Voyage AI (embeddings)
  results.voyageAI = {
    configured: !!process.env.VOYAGE_API_KEY,
    keyPrefix: process.env.VOYAGE_API_KEY
      ? `${process.env.VOYAGE_API_KEY.substring(0, 10)}...`
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

// ---------------------------------------------------------------------------
// GET /api/superadmin/ai
// AI pipeline status: config, embedding job, Qdrant collection, WineEmbedding stats
// ---------------------------------------------------------------------------
router.get('/ai', async (req, res) => {
  try {
    const cfg = aiConfig.get();
    const jobStatus = embeddingJob.getStatus();

    // WineEmbedding stats from MongoDB
    const [totalEmbeddings, byStatusRaw, byModelRaw, latestEmbedding] = await Promise.all([
      WineEmbedding.countDocuments(),
      WineEmbedding.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      WineEmbedding.aggregate([
        { $group: { _id: { model: '$model', indexVersion: '$indexVersion' }, count: { $sum: 1 } } },
        { $sort: { '_id.indexVersion': -1 } },
      ]),
      WineEmbedding.findOne().sort({ embeddedAt: -1 }).select('embeddedAt model indexVersion').lean(),
    ]);

    // Qdrant collection info for the active index
    let collectionInfo = null;
    try {
      collectionInfo = await vectorStore.collectionInfo(cfg.vectorIndex);
    } catch {
      collectionInfo = { exists: false, vectorCount: 0, name: `wines_${cfg.vectorIndex}` };
    }

    res.json({
      configured: {
        voyageAI:  !!process.env.VOYAGE_API_KEY,
        qdrant:    !!process.env.QDRANT_URL,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
      },
      config: cfg,
      job: jobStatus,
      collection: collectionInfo,
      embeddings: {
        total: totalEmbeddings,
        byStatus: Object.fromEntries(byStatusRaw.map(d => [d._id || 'unknown', d.count])),
        byModel: byModelRaw.map(d => ({
          model: d._id.model,
          indexVersion: d._id.indexVersion,
          count: d.count,
        })),
        lastEmbeddedAt: latestEmbedding?.embeddedAt || null,
      },
    });
  } catch (error) {
    console.error('[superadmin] ai error:', error);
    res.status(500).json({ error: 'Failed to load AI stats' });
  }
});


// ---------------------------------------------------------------------------
// PATCH /api/superadmin/ai/chat-limits
// Update per-plan daily chat limits stored in aiConfig
// ---------------------------------------------------------------------------
router.patch('/ai/chat-limits', async (req, res) => {
  const { free, basic, premium } = req.body;
  const parse = (v) => parseInt(v, 10);
  const vals = { free: parse(free), basic: parse(basic), premium: parse(premium) };
  if (Object.values(vals).some(v => isNaN(v) || v < 0)) {
    return res.status(400).json({ error: 'Each limit must be a non-negative integer' });
  }
  try {
    const SiteConfig = require('../models/SiteConfig');
    const current = aiConfig.get();
    const updated = { ...current, chatDailyLimits: vals };
    await SiteConfig.findOneAndUpdate(
      { key: 'aiConfig' },
      { $set: { value: updated, updatedAt: new Date(), updatedBy: req.user.id } },
      { upsert: true }
    );
    aiConfig.set(updated);
    res.json({ chatDailyLimits: vals });
  } catch (error) {
    console.error('[superadmin] chat-limits error:', error);
    res.status(500).json({ error: 'Failed to save chat limits' });
  }
});


// ---------------------------------------------------------------------------
// PATCH /api/superadmin/ai/system-prompt
// ---------------------------------------------------------------------------
router.patch('/ai/system-prompt', async (req, res) => {
  const { prompt } = req.body;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt must be a non-empty string' });
  }
  if (prompt.length > 4000) {
    return res.status(400).json({ error: 'prompt must be 4000 characters or fewer' });
  }
  try {
    const SiteConfig = require('../models/SiteConfig');
    const current = aiConfig.get();
    const updated = { ...current, chatSystemPrompt: prompt.trim() };
    await SiteConfig.findOneAndUpdate(
      { key: 'aiConfig' },
      { $set: { value: updated, updatedAt: new Date(), updatedBy: req.user.id } },
      { upsert: true }
    );
    aiConfig.set(updated);
    res.json({ chatSystemPrompt: updated.chatSystemPrompt });
  } catch (error) {
    console.error('[superadmin] system-prompt error:', error);
    res.status(500).json({ error: 'Failed to save system prompt' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/ai/chat-model
// ---------------------------------------------------------------------------
router.patch('/ai/chat-model', async (req, res) => {
  const { model, fallbackModel } = req.body;
  const { VALID_CHAT_MODELS } = aiConfig;

  if (!model || !VALID_CHAT_MODELS.includes(model)) {
    return res.status(400).json({ error: `model must be one of: ${VALID_CHAT_MODELS.join(', ')}` });
  }
  if (fallbackModel !== undefined && fallbackModel !== null && !VALID_CHAT_MODELS.includes(fallbackModel)) {
    return res.status(400).json({ error: `fallbackModel must be one of: ${VALID_CHAT_MODELS.join(', ')} or null` });
  }
  if (fallbackModel !== null && fallbackModel === model) {
    return res.status(400).json({ error: 'fallbackModel must be different from the primary model' });
  }

  try {
    const SiteConfig = require('../models/SiteConfig');
    const current = aiConfig.get();
    const updated = {
      ...current,
      chatModel: model,
      chatModelFallback: fallbackModel !== undefined ? fallbackModel : current.chatModelFallback,
    };
    await SiteConfig.findOneAndUpdate(
      { key: 'aiConfig' },
      { $set: { value: updated, updatedAt: new Date(), updatedBy: req.user.id } },
      { upsert: true }
    );
    aiConfig.set(updated);
    res.json({ chatModel: model, chatModelFallback: updated.chatModelFallback });
  } catch (error) {
    console.error('[superadmin] chat-model error:', error);
    res.status(500).json({ error: 'Failed to save chat model' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/superadmin/chat-usage?days=30&limit=50&offset=0
// Per-user Cellar Chat usage: question count + token totals
// ---------------------------------------------------------------------------
router.get('/chat-usage', async (req, res) => {
  try {
    const days   = Math.min(Math.max(parseInt(req.query.days,   10) || 30,  1), 90);
    const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 50,  1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Compute date range (inclusive)
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const sinceStr = since.toISOString().slice(0, 10);

    // Aggregate usage per user over the requested window
    const pipeline = [
      { $match: { date: { $gte: sinceStr } } },
      {
        $group: {
          _id:          '$userId',
          questions:    { $sum: '$count' },
          inputTokens:  { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          lastActive:   { $max: '$date' },
        },
      },
      { $sort: { questions: -1 } },
    ];

    const allRows = await ChatUsage.aggregate(pipeline);
    const total = allRows.length;
    const page  = allRows.slice(offset, offset + limit);

    // Populate user info
    const userIds = page.map(r => r._id);
    const users   = await User.find({ _id: { $in: userIds } })
      .select('username email plan')
      .lean();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));

    const rows = page.map(r => {
      const u = userMap[String(r._id)] || {};
      return {
        userId:       r._id,
        username:     u.username || '(deleted)',
        email:        u.email    || null,
        plan:         u.plan     || 'free',
        questions:    r.questions,
        inputTokens:  r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens:  r.inputTokens + r.outputTokens,
        lastActive:   r.lastActive,
      };
    });

    res.json({ rows, total, limit, offset, days });
  } catch (error) {
    console.error('[superadmin] chat-usage error:', error);
    res.status(500).json({ error: 'Failed to load chat usage' });
  }
});

module.exports = router;
