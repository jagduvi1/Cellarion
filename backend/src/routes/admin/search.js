const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

/**
 * POST /api/admin/search/reindex — force a full Meilisearch rebuild of the
 * wines + bottles indexes from the RUNNING process.
 *
 * Why this exists (found testing a prod-copy restore, 2026-07-29): after a
 * mongo restore the boot-time sync skips — the index "looks populated" — and
 * a stale index silently disables the fuzzy dedup net, so users' near-
 * duplicate adds mint duplicates with no error anywhere. The only in-process
 * workaround was renaming a taxonomy country to itself. This is the honest
 * button, and the restore runbook's missing step.
 *
 * Serial on purpose (wines, then bottles) and awaited to completion so the
 * response means "done", not "started" — at the registry's size the whole
 * rebuild is seconds, and an admin clicking this wants to KNOW it worked.
 */
router.post('/reindex', async (req, res) => {
  try {
    if (!searchService.getIsAvailable()) {
      return res.status(503).json({ error: 'Meilisearch is not available' });
    }
    const t0 = Date.now();
    await searchService.fullSync();
    const winesMs = Date.now() - t0;
    const t1 = Date.now();
    await searchService.fullSyncBottles();
    const bottlesMs = Date.now() - t1;

    logAudit(req, 'admin.search.reindex', {}, { winesMs, bottlesMs });
    res.json({ ok: true, winesMs, bottlesMs });
  } catch (error) {
    console.error('Search reindex error:', error);
    res.status(500).json({ error: 'Reindex failed' });
  }
});

module.exports = router;
