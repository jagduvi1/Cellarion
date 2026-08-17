/**
 * Personal typed key/value data on wines and bottles (issue #986).
 * Thin HTTP wrappers over services/personalData.js — the logic layer shared
 * with the MCP tools (mcp/tools/personalData.js). Keep semantics there.
 */
const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { requireBottleAccess } = require('../middleware/bottleAccess');
const personalData = require('../services/personalData');
const { logAudit } = require('../services/audit');

const router = express.Router();

router.use(requireAuth);

const CODE_STATUS = {
  invalid: 400,
  limit: 400,
  banned: 403,
  not_found: 404,
  type_conflict: 409,
};

const sendFail = (res, result) =>
  res.status(CODE_STATUS[result.code] || 400).json({ error: result.message });

/**
 * GET /api/personal-data/keys
 * The caller's own key vocabulary (for type-ahead).
 */
router.get('/keys', async (req, res, next) => {
  try {
    const result = await personalData.listKeys(req.user.id);
    res.json({ keys: result.keys });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/personal-data/bottle/:id
 * All entries visible on this bottle's page: the bottle's own entries plus
 * wine-level entries authored by current members of the bottle's cellar.
 * Any cellar role can read — same audience as the bottle page itself.
 */
router.get('/bottle/:id', requireBottleAccess('viewer'), async (req, res, next) => {
  try {
    const result = await personalData.listForBottle(req.bottle, req.cellar);
    res.json({ bottleEntries: result.bottleEntries, wineEntries: result.wineEntries });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/personal-data/bottle/:id
 * Create an entry on this bottle (level 'bottle') or its wine (level 'wine').
 * Body: { level, keyId? | newKey? {name,type,unit,enumOptions}, value }
 * Any cellar role may write — the data is the author's own, attributed.
 * Demo visitors are excluded (ephemeral accounts would orphan shared-visible
 * rows when the reaper hard-deletes them).
 */
router.post('/bottle/:id', requireNonDemo, requireBottleAccess('viewer'), async (req, res, next) => {
  try {
    const { level, keyId, newKey, value } = req.body || {};
    const result = await personalData.createEntry(req.user.id, req.bottle, {
      level, keyId, newKey, value,
    });
    if (!result.ok) return sendFail(res, result);
    logAudit(
      req,
      'personal_data.entry_create',
      { type: level === 'wine' ? 'wine' : 'bottle', id: result.entry._id, cellarId: req.cellar._id },
      { key: result.entry.key.name, keyCreated: result.keyCreated }
    );
    res.status(201).json({ entry: result.entry });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/personal-data/entries/:entryId — author-only value update.
 */
router.put('/entries/:entryId', requireNonDemo, async (req, res, next) => {
  try {
    const result = await personalData.updateEntry(req.user.id, req.params.entryId, req.body?.value);
    if (!result.ok) return sendFail(res, result);
    logAudit(req, 'personal_data.entry_update',
      { type: result.entry.level, id: result.entry._id },
      { key: result.entry.key.name });
    res.json({ entry: result.entry });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/personal-data/entries/:entryId — author-only.
 */
router.delete('/entries/:entryId', requireNonDemo, async (req, res, next) => {
  try {
    const result = await personalData.deleteEntry(req.user.id, req.params.entryId);
    if (!result.ok) return sendFail(res, result);
    logAudit(req, 'personal_data.entry_delete',
      { type: result.entry.level, id: result.entry._id },
      { key: result.entry.key.name });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
