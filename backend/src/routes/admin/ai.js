/**
 * Admin routes for the AI chat system.
 *
 * POST /api/admin/ai/embed/start     – start (or restart) a batch embedding job
 * POST /api/admin/ai/embed/stop      – request graceful job stop
 * POST /api/admin/ai/enrich/start    – start an AI enrichment job
 * POST /api/admin/ai/enrich/stop     – request graceful enrichment stop
 *
 * AI config reads/writes live under /api/superadmin/ai (see superadmin.js).
 */

const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const embeddingJob = require('../../services/embeddingJob');
const enrichmentJob = require('../../services/enrichmentJob');
const { logAudit } = require('../../services/audit');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// ── Embedding job ──────────────────────────────────────────────────────────

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

// ── Enrichment job (AI tasting/style profiles) ─────────────────────────────

// POST /api/admin/ai/enrich/start
router.post('/enrich/start', async (req, res) => {
  try {
    const mode = req.body.mode === 'full' ? 'full' : 'incremental';
    const rawLimit = parseInt(req.body.limit, 10);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100000) : 0;
    await enrichmentJob.start({ mode, limit });
    logAudit(req, 'admin.ai.enrich.start', {}, { mode, limit });
    res.json({ message: `Enrichment job started (${mode} mode${limit ? `, max ${limit}` : ''})`, status: enrichmentJob.getStatus() });
  } catch (err) {
    if (err.message === 'A job is already running') {
      return res.status(409).json({ error: err.message });
    }
    console.error('[admin/ai] POST enrich/start error:', err);
    res.status(500).json({ error: err.message || 'Failed to start enrichment job' });
  }
});

// POST /api/admin/ai/enrich/stop
router.post('/enrich/stop', async (req, res) => {
  try {
    enrichmentJob.requestStop();
    logAudit(req, 'admin.ai.enrich.stop', {}, {});
    res.json({ message: 'Stop requested', status: enrichmentJob.getStatus() });
  } catch (err) {
    console.error('[admin/ai] POST enrich/stop error:', err);
    res.status(500).json({ error: 'Failed to stop enrichment job' });
  }
});

module.exports = router;
