const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

/**
 * POST /api/admin/search/reindex — force a full Meilisearch rebuild of the
 * wines + bottles + discussions indexes from the RUNNING process.
 *
 * Why this exists (found testing a prod-copy restore, 2026-07-29): after a
 * mongo restore the boot-time sync skips — the index "looks populated" — and
 * a stale index silently disables the fuzzy dedup net, so users' near-
 * duplicate adds mint duplicates with no error anywhere. The only in-process
 * workaround was renaming a taxonomy country to itself. This is the honest
 * button, and the restore runbook's missing step.
 *
 * Discussions joined 2026-08-31: the endpoint predated that index, so "full
 * rebuild" quietly meant two of three. It matters the same way — stored
 * documents only learn a NEW filterable attribute (like the forum `language`
 * field) when re-uploaded, and this button is how a deploy adds one without
 * a MEILI_FORCE_REINDEX restart.
 *
 * Serial on purpose and awaited to completion so the response means "done",
 * not "started" — at the registry's size the whole rebuild is seconds, and
 * an admin clicking this wants to KNOW it worked.
 */
router.post('/reindex', async (req, res) => {
  try {
    if (!searchService.getIsAvailable()) {
      return res.status(503).json({ error: 'Meilisearch is not available' });
    }
    // fullSync returns the enqueued Meili task uids — addDocuments is 202 +
    // async task, so without waitForTasks the response would mean "enqueued",
    // not "searchable", and async indexing failures would be invisible
    // (audit 2026-07-29). The wait makes the durations honest too.
    const t0 = Date.now();
    const wineTasks = await searchService.fullSync();
    await searchService.waitForTasks(wineTasks);
    const winesMs = Date.now() - t0;
    const t1 = Date.now();
    const bottleTasks = await searchService.fullSyncBottles();
    await searchService.waitForTasks(bottleTasks);
    const bottlesMs = Date.now() - t1;
    const t2 = Date.now();
    const discussionTasks = await searchService.fullSyncDiscussions();
    await searchService.waitForTasks(discussionTasks);
    const discussionsMs = Date.now() - t2;

    logAudit(req, 'admin.search.reindex', {}, { winesMs, bottlesMs, discussionsMs });
    res.json({ ok: true, winesMs, bottlesMs, discussionsMs });
  } catch (error) {
    console.error('Search reindex error:', error);
    res.status(500).json({ error: 'Reindex failed' });
  }
});

module.exports = router;
