const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/superAdmin');
const User = require('../models/User');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const Cellar = require('../models/Cellar');
const BottleImage = require('../models/BottleImage');
const WineRequest = require('../models/WineRequest');
const Rack = require('../models/Rack');
const WineEmbedding = require('../models/WineEmbedding');
const ChatUsage = require('../models/ChatUsage');
const BackupStatus = require('../models/BackupStatus');
const embeddingJob = require('../services/embeddingJob');
const enrichmentJob = require('../services/enrichmentJob');
const vectorStore = require('../services/vectorStore');
const aiConfig = require('../config/aiConfig');
const announcementConfig = require('../config/announcement');
const aiChat = require('../services/aiChat');
const aiProvider = require('../services/aiProvider');
const { isEmbeddingConfigured, embeddingProviderName } = require('../services/embedding');
const { updateSiteConfig } = require('../utils/siteConfig');
const { parsePagination } = require('../utils/pagination');
const { escapeRegex } = require('../utils/sanitize');
const { coerceStringQuery } = require('../utils/validation');
const { SYSTEM_PROMPT_MAX_LENGTH, SCAN_PROMPT_MAX_LENGTH, CONSUMED_STATUSES } = require('../config/constants');

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
      Bottle.countDocuments({ status: { $nin: CONSUMED_STATUSES } }),
      Bottle.countDocuments({ status: { $in: CONSUMED_STATUSES } }),
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
    const meiliKey = process.env.MEILI_SEARCH_KEY || process.env.MEILI_MASTER_KEY;
    const t0 = Date.now();
    const meiliRes = await fetch(`${meiliUrl}/health`, {
      headers: { Authorization: `Bearer ${meiliKey}` },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - t0;
    const data = await meiliRes.json();
    results.meilisearch = { status: data.status || 'unknown', latencyMs };
  } catch (e) {
    console.error('[superadmin] Meilisearch health check failed:', e.message);
    results.meilisearch = { status: 'error', error: 'Service unavailable' };
  }

  // Meilisearch stats (index info)
  try {
    const meiliUrl = process.env.MEILI_URL || 'http://meilisearch:7700';
    const meiliKey = process.env.MEILI_SEARCH_KEY || process.env.MEILI_MASTER_KEY;
    const statsRes = await fetch(`${meiliUrl}/stats`, {
      headers: { Authorization: `Bearer ${meiliKey}` },
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
    console.error('[superadmin] rembg health check failed:', e.message);
    results.rembg = { status: 'error', error: 'Service unavailable' };
  }

  // LLM provider (Anthropic by default; OpenAI-compatible when AI_PROVIDER=openai)
  results.anthropic = {
    configured: aiProvider.isConfigured(),
    provider: aiProvider.providerName(),
  };

  // Embedding provider (Voyage by default; OpenAI-compatible when EMBEDDING_PROVIDER=openai)
  results.voyageAI = {
    configured: isEmbeddingConfigured(),
    provider: embeddingProviderName(),
  };

  // Qdrant (optional)
  if (process.env.QDRANT_URL) {
    try {
      const t0 = Date.now();
      const qdrantRes = await fetch(`${process.env.QDRANT_URL}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - t0;
      results.qdrant = { status: qdrantRes.ok ? 'ok' : 'error', latencyMs };
    } catch (e) {
      console.error('[superadmin] Qdrant health check failed:', e.message);
      results.qdrant = { status: 'error', error: 'Service unavailable' };
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
// GET /api/superadmin/users?limit=200&offset=0&search=
// All users with full details (no pagination limits enforced — super admin only)
// ---------------------------------------------------------------------------
router.get('/users', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query, { limit: 100, maxLimit: 500 });
    const filter = {};

    const search = coerceStringQuery(req.query.search).trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ username: re }, { email: re }];
    }
    if (req.query.plan) {
      filter.plan = String(req.query.plan);
    }
    if (req.query.role) {
      filter.roles = String(req.query.role);
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('username email roles plan planStartedAt planExpiresAt createdAt emailVerified')
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
// GET /api/superadmin/backups
// Backup health as REPORTED by the backup job (scripts/backup/backup.sh).
// The app only reads this report — it never accesses the backup repo or its
// credentials, so a compromise of the app can't reach the backups.
// ---------------------------------------------------------------------------
router.get('/backups', async (req, res) => {
  try {
    const doc = await BackupStatus.findById('latest').lean();
    if (!doc) return res.json({ configured: false });
    const lastRunAt = doc.lastRunAt ? new Date(doc.lastRunAt) : null;
    const ageHours = lastRunAt ? (Date.now() - lastRunAt.getTime()) / 3600000 : null;
    // Daily schedule → never-run or older than ~26h counts as stale.
    const stale = ageHours == null || ageHours > 26;
    res.json({ configured: true, stale, ageHours, ...doc });
  } catch (error) {
    console.error('[superadmin] backups error:', error);
    res.status(500).json({ error: 'Failed to load backup status' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/superadmin/ai
// AI pipeline status: config, embedding job, Qdrant collection, WineEmbedding stats
// ---------------------------------------------------------------------------
router.get('/ai', async (req, res) => {
  try {
    const cfg = aiConfig.getRaw();
    const jobStatus = embeddingJob.getStatus();
    const enrichStatus = enrichmentJob.getStatus();

    // Wine-enrichment coverage (how many wines have an AI profile)
    const [totalWines, enrichedWines] = await Promise.all([
      WineDefinition.countDocuments(),
      WineDefinition.countDocuments({ 'aiProfile.description': { $ne: null } }),
    ]);

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
        voyageAI:  isEmbeddingConfigured(),
        qdrant:    !!process.env.QDRANT_URL,
        anthropic: aiProvider.isConfigured(),
      },
      // Lets the UI flag that model settings below are env-governed and inert
      // when a provider runs in openai mode (prompts still apply).
      providers: {
        llm: aiProvider.providerName(),
        embedding: embeddingProviderName(),
      },
      config: cfg,
      job: jobStatus,
      enrichmentJob: enrichStatus,
      enrichment: { totalWines, enrichedWines },
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
      chatEventLog: aiChat.getEventLog(),
    });
  } catch (error) {
    console.error('[superadmin] ai error:', error);
    res.status(500).json({ error: 'Failed to load AI stats' });
  }
});


// ---------------------------------------------------------------------------
// PATCH /api/superadmin/ai/chat-limit
// Update the global daily Cellar Chat limit (questions per user per day).
// Applies to every user regardless of plan. -1 = unlimited.
// ---------------------------------------------------------------------------
router.patch('/ai/chat-limit', async (req, res) => {
  const limit = parseInt(req.body.limit, 10);
  if (!Number.isInteger(limit) || limit < -1) {
    return res.status(400).json({ error: 'limit must be an integer of -1 (unlimited) or greater' });
  }
  try {
    const current = aiConfig.getRaw();
    const updated = { ...current, chatDailyLimit: limit };
    await updateSiteConfig('aiConfig', updated, req.user.id);
    aiConfig.set(updated);
    res.json({ chatDailyLimit: limit });
  } catch (error) {
    console.error('[superadmin] chat-limit error:', error);
    res.status(500).json({ error: 'Failed to save chat limit' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/ai/enrichment-gate
// The two publication-gate thresholds (ticket 6a83e765, calibrated 2026-08-18
// — floor 0.40 / unknown-bar 0.55). Stored like every other aiConfig key, so
// tuning never needs a release; load() clamps junk back to the defaults.
// ---------------------------------------------------------------------------
router.patch('/ai/enrichment-gate', async (req, res) => {
  const floor = Number(req.body.floor);
  const unknownBar = Number(req.body.unknownBar);
  const bad = (v) => !Number.isFinite(v) || v < 0 || v > 1;
  if (bad(floor) || bad(unknownBar)) {
    return res.status(400).json({ error: 'floor and unknownBar must be numbers between 0 and 1' });
  }
  if (unknownBar < floor) {
    return res.status(400).json({ error: 'unknownBar must be at or above floor — the unknown-producer hold is the stricter check' });
  }
  try {
    const current = aiConfig.getRaw();
    const updated = { ...current, enrichmentHoldConfidenceFloor: floor, enrichmentHoldUnknownConfidenceBar: unknownBar };
    await updateSiteConfig('aiConfig', updated, req.user.id);
    aiConfig.set(updated);
    res.json({ enrichmentHoldConfidenceFloor: floor, enrichmentHoldUnknownConfidenceBar: unknownBar });
  } catch (error) {
    console.error('[superadmin] enrichment-gate error:', error);
    res.status(500).json({ error: 'Failed to save gate thresholds' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/ai/enrichment-search
// The web-search rescue pilot's two knobs (2026-08-19): kill-switch + daily
// cap. Same aiConfig storage as the gate above — turning the pilot off never
// needs a release, and load() clamps junk back to the defaults (on / 5).
// ---------------------------------------------------------------------------
router.patch('/ai/enrichment-search', async (req, res) => {
  const enabled = req.body.enabled;
  const dailyCap = Number(req.body.dailyCap);
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  if (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > 100) {
    return res.status(400).json({ error: 'dailyCap must be an integer between 0 and 100' });
  }
  try {
    const current = aiConfig.getRaw();
    const updated = { ...current, enrichmentSearchEnabled: enabled, enrichmentSearchDailyCap: dailyCap };
    await updateSiteConfig('aiConfig', updated, req.user.id);
    aiConfig.set(updated);
    res.json({ enrichmentSearchEnabled: enabled, enrichmentSearchDailyCap: dailyCap });
  } catch (error) {
    console.error('[superadmin] enrichment-search error:', error);
    res.status(500).json({ error: 'Failed to save search settings' });
  }
});


// ---------------------------------------------------------------------------
// PATCH /api/superadmin/ai/<*>-prompt and /api/superadmin/ai/<*>-model
//
// These settings routes all share the same shape, so they are registered from
// the route table below. Prompt routes validate a non-empty string within a
// max length and save the trimmed value into a single aiConfig key; model
// routes validate against the VALID_CHAT_MODELS allowlist and save a single
// aiConfig key. The console.error label is the path minus the '/ai/' prefix.
// ---------------------------------------------------------------------------
function registerPromptRoute(path, configKey, maxLen, saveErrorMsg) {
  const label = path.slice('/ai/'.length);
  router.patch(path, async (req, res) => {
    const { prompt } = req.body;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt must be a non-empty string' });
    }
    if (prompt.length > maxLen) {
      return res.status(400).json({ error: `prompt must be ${maxLen} characters or fewer` });
    }
    try {
      const current = aiConfig.getRaw();
      const updated = { ...current, [configKey]: prompt.trim() };
      await updateSiteConfig('aiConfig', updated, req.user.id);
      aiConfig.set(updated);
      res.json({ [configKey]: updated[configKey] });
    } catch (error) {
      console.error(`[superadmin] ${label} error:`, error);
      res.status(500).json({ error: saveErrorMsg });
    }
  });
}

function registerModelRoute(path, configKey, saveErrorMsg) {
  const label = path.slice('/ai/'.length);
  router.patch(path, async (req, res) => {
    const { model } = req.body;
    const { VALID_CHAT_MODELS } = aiConfig;

    if (!model || !VALID_CHAT_MODELS.includes(model)) {
      return res.status(400).json({ error: `model must be one of: ${VALID_CHAT_MODELS.join(', ')}` });
    }

    try {
      const current = aiConfig.getRaw();
      const updated = { ...current, [configKey]: model };
      await updateSiteConfig('aiConfig', updated, req.user.id);
      aiConfig.set(updated);
      res.json({ [configKey]: model });
    } catch (error) {
      console.error(`[superadmin] ${label} error:`, error);
      res.status(500).json({ error: saveErrorMsg });
    }
  });
}

// Route table (registration order preserved from the original handlers).
registerPromptRoute('/ai/system-prompt',        'chatSystemPrompt',   SYSTEM_PROMPT_MAX_LENGTH, 'Failed to save system prompt');
registerPromptRoute('/ai/label-scan-prompt',    'labelScanPrompt',    SCAN_PROMPT_MAX_LENGTH,   'Failed to save label scan prompt');
// The back-label rescue prompt (POST /api/wines/scan-label-back). No model
// route beside it: the back scan runs on labelScanModel, above.
registerPromptRoute('/ai/label-scan-back-prompt', 'labelScanBackPrompt', SCAN_PROMPT_MAX_LENGTH, 'Failed to save back label scan prompt');
registerPromptRoute('/ai/import-lookup-prompt', 'importLookupPrompt', SCAN_PROMPT_MAX_LENGTH,   'Failed to save import lookup prompt');
registerModelRoute('/ai/import-lookup-model',   'importLookupModel',  'Failed to save import lookup model');
registerModelRoute('/ai/label-scan-model',      'labelScanModel',     'Failed to save label scan model');
registerPromptRoute('/ai/maturity-suggest-prompt', 'maturitySuggestPrompt', SCAN_PROMPT_MAX_LENGTH, 'Failed to save maturity suggest prompt');
// The -nv route edits the non-vintage variant of the maturity suggest prompt
// (asks for year-offsets after purchase instead of calendar years).
registerPromptRoute('/ai/maturity-suggest-prompt-nv', 'maturitySuggestPromptNv', SCAN_PROMPT_MAX_LENGTH, 'Failed to save NV maturity suggest prompt');
registerModelRoute('/ai/maturity-suggest-model', 'maturitySuggestModel', 'Failed to save maturity suggest model');
registerPromptRoute('/ai/price-suggest-prompt', 'priceSuggestPrompt', SCAN_PROMPT_MAX_LENGTH,   'Failed to save price suggest prompt');
registerModelRoute('/ai/price-suggest-model',   'priceSuggestModel',  'Failed to save price suggest model');
registerPromptRoute('/ai/enrichment-prompt',    'enrichmentPrompt',   SCAN_PROMPT_MAX_LENGTH,   'Failed to save enrichment prompt');
registerModelRoute('/ai/enrichment-model',      'enrichmentModel',    'Failed to save enrichment model');

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

  try {
    const current = aiConfig.getRaw();
    // Validate the invariant against the EFFECTIVE pair — an omitted
    // fallbackModel keeps the stored one, which must not equal the new model.
    const effectiveFallback = fallbackModel !== undefined ? fallbackModel : current.chatModelFallback;
    if (effectiveFallback !== null && effectiveFallback !== undefined && effectiveFallback === model) {
      return res.status(400).json({ error: 'fallbackModel must be different from the primary model' });
    }
    const updated = {
      ...current,
      chatModel: model,
      chatModelFallback: effectiveFallback,
    };
    await updateSiteConfig('aiConfig', updated, req.user.id);
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
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const { limit, offset } = parsePagination(req.query, { limit: 50, maxLimit: 500 });

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

// ---------------------------------------------------------------------------
// GET /api/superadmin/announcement
// Current site-wide announcement banner config
// ---------------------------------------------------------------------------
router.get('/announcement', (req, res) => {
  res.json({ config: announcementConfig.get() });
});

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/announcement
// Set/clear the banner shown to all users (e.g. planned maintenance notice)
// ---------------------------------------------------------------------------
router.patch('/announcement', async (req, res) => {
  const { enabled, message, messageSv, type } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  if (typeof message !== 'string' || (enabled && !message.trim())) {
    return res.status(400).json({ error: 'message is required when the banner is enabled' });
  }
  if (message.length > 500 || (typeof messageSv === 'string' && messageSv.length > 500)) {
    return res.status(400).json({ error: 'messages must be 500 characters or fewer' });
  }
  if (!['info', 'warning'].includes(type)) {
    return res.status(400).json({ error: 'type must be info or warning' });
  }
  try {
    const updated = {
      enabled,
      message: message.trim(),
      messageSv: typeof messageSv === 'string' ? messageSv.trim() : '',
      type,
    };
    const doc = await updateSiteConfig('announcement', updated, req.user.id);
    // updatedAt doubles as the dismissal version on the client
    announcementConfig.set({ ...updated, updatedAt: doc.updatedAt.toISOString() });
    res.json({ config: announcementConfig.get() });
  } catch (error) {
    console.error('[superadmin] announcement error:', error);
    res.status(500).json({ error: 'Failed to save announcement' });
  }
});

module.exports = router;
