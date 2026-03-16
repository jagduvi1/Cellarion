/**
 * Admin routes for the AI chat system.
 *
 * GET  /api/admin/ai/config          – read feature flags
 * PATCH /api/admin/ai/config         – update feature flags
 * GET  /api/admin/ai/embed/status    – current job status + Qdrant collection info
 * POST /api/admin/ai/embed/start     – start (or restart) a batch embedding job
 * POST /api/admin/ai/embed/stop      – request graceful job stop
 */

const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const aiConfig = require('../../config/aiConfig');
const embeddingJob = require('../../services/embeddingJob');
const vectorStore = require('../../services/vectorStore');
const { logAudit } = require('../../services/audit');
const { updateSiteConfig } = require('../../utils/siteConfig');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// ── Feature-flag config ────────────────────────────────────────────────────

// GET /api/admin/ai/config
router.get('/config', async (req, res) => {
  try {
    res.json({ config: aiConfig.get(), defaults: aiConfig.defaults });
  } catch (err) {
    console.error('[admin/ai] GET config error:', err);
    res.status(500).json({ error: 'Failed to load AI config' });
  }
});

// PATCH /api/admin/ai/config
router.patch('/config', async (req, res) => {
  try {
    const allowed = ['chatEnabled', 'embeddingModel', 'vectorIndex', 'chatTopK', 'chatMaxResults', 'chatMaxTokens', 'chatMaxHistoryTurns', 'embeddingBatchDelayMs'];
    const incoming = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) incoming[key] = req.body[key];
    }

    // Validate
    if (incoming.chatEnabled !== undefined && typeof incoming.chatEnabled !== 'boolean') {
      return res.status(400).json({ error: 'chatEnabled must be boolean' });
    }
    if (incoming.chatTopK !== undefined && (!Number.isInteger(incoming.chatTopK) || incoming.chatTopK < 1 || incoming.chatTopK > 200)) {
      return res.status(400).json({ error: 'chatTopK must be an integer 1–200' });
    }
    if (incoming.chatMaxResults !== undefined && (!Number.isInteger(incoming.chatMaxResults) || incoming.chatMaxResults < 1 || incoming.chatMaxResults > 20)) {
      return res.status(400).json({ error: 'chatMaxResults must be an integer 1–20' });
    }
    if (incoming.chatMaxTokens !== undefined && (!Number.isInteger(incoming.chatMaxTokens) || incoming.chatMaxTokens < 200 || incoming.chatMaxTokens > 4096)) {
      return res.status(400).json({ error: 'chatMaxTokens must be an integer 200–4096' });
    }
    if (incoming.chatMaxHistoryTurns !== undefined && (!Number.isInteger(incoming.chatMaxHistoryTurns) || incoming.chatMaxHistoryTurns < 0 || incoming.chatMaxHistoryTurns > 50)) {
      return res.status(400).json({ error: 'chatMaxHistoryTurns must be an integer 0–50' });
    }
    if (incoming.embeddingBatchDelayMs !== undefined && (!Number.isInteger(incoming.embeddingBatchDelayMs) || incoming.embeddingBatchDelayMs < 0)) {
      return res.status(400).json({ error: 'embeddingBatchDelayMs must be a non-negative integer' });
    }

    const previous = aiConfig.get();
    const updated = { ...previous, ...incoming };

    await updateSiteConfig('aiConfig', updated, req.user.id);
    aiConfig.set(updated);

    logAudit(req, 'admin.ai.config.update', {}, { from: previous, to: updated });

    res.json({ config: updated });
  } catch (err) {
    console.error('[admin/ai] PATCH config error:', err);
    res.status(500).json({ error: 'Failed to update AI config' });
  }
});

// ── Embedding job ──────────────────────────────────────────────────────────

// GET /api/admin/ai/embed/status
router.get('/embed/status', async (req, res) => {
  try {
    const jobStatus = embeddingJob.getStatus();
    const cfg = aiConfig.get();

    // Also fetch Qdrant collection stats
    let collectionInfo = null;
    try {
      collectionInfo = await vectorStore.collectionInfo(cfg.vectorIndex);
    } catch (_) {
      collectionInfo = { exists: false, vectorCount: 0, name: `wines_${cfg.vectorIndex}` };
    }

    res.json({ job: jobStatus, collection: collectionInfo, config: cfg });
  } catch (err) {
    console.error('[admin/ai] GET embed/status error:', err);
    res.status(500).json({ error: 'Failed to fetch embedding status' });
  }
});

// POST /api/admin/ai/embed/start
router.post('/embed/start', async (req, res) => {
  try {
    const mode = req.body.mode === 'full' ? 'full' : 'incremental';
    await embeddingJob.start({ mode });
    logAudit(req, 'admin.ai.embed.start', {}, { mode });
    res.json({ message: `Embedding job started (${mode} mode)`, status: embeddingJob.getStatus() });
  } catch (err) {
    if (err.message === 'A job is already running') {
      return res.status(409).json({ error: err.message });
    }
    console.error('[admin/ai] POST embed/start error:', err);
    res.status(500).json({ error: 'Failed to start embedding job' });
  }
});

// POST /api/admin/ai/embed/stop
router.post('/embed/stop', async (req, res) => {
  try {
    embeddingJob.requestStop();
    logAudit(req, 'admin.ai.embed.stop', {}, {});
    res.json({ message: 'Stop requested', status: embeddingJob.getStatus() });
  } catch (err) {
    console.error('[admin/ai] POST embed/stop error:', err);
    res.status(500).json({ error: 'Failed to stop embedding job' });
  }
});

module.exports = router;
