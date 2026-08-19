/**
 * Self-service cellar analytics (#987 Phase 0/1).
 *
 * Two endpoints, both thin wrappers over services/analytics/*:
 *   GET  /api/analytics/catalogue — every field the caller may analyse
 *                                   (static core + their personal keys +
 *                                   the accepted public vocabulary)
 *   POST /api/analytics/query     — the one query endpoint every surface
 *                                   (table, CSV, charts, saved views) uses
 *
 * The engine treats the request as data, never code: field keys resolve
 * against the catalogue, operators against a per-type whitelist, values are
 * cast per declared type — see queryEngine.js for the invariants. Reads only;
 * no audit entries (nothing mutates).
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { composeCatalogue, opsForType } = require('../services/analytics/fieldCatalogue');
const { runQuery, QueryError } = require('../services/analytics/queryEngine');
const SavedDashboard = require('../models/SavedDashboard');
const { logAudit } = require('../services/audit');

const router = express.Router();

router.use(requireAuth);

// ── Dashboard (#987 R-E): one per user, upserted whole ─────────────────────
// The default 'My cellar' dashboard lives client-side; a row exists only
// once the user customizes. Widgets' stored queries are DATA — the engine
// revalidates on every render, so nothing here needs to re-know its rules.

const VIZ = new Set(['kpi', 'bar', 'donut', 'line', 'table']);
const SIZES = new Set(['half', 'full']);

router.get('/dashboard', async (req, res, next) => {
  try {
    const doc = await SavedDashboard.findOne({ user: req.user.id }).lean();
    res.json({ dashboard: doc ? { widgets: doc.widgets, updatedAt: doc.updatedAt } : null });
  } catch (err) {
    next(err);
  }
});

router.put('/dashboard', async (req, res, next) => {
  try {
    const widgets = req.body?.widgets;
    if (!Array.isArray(widgets) || widgets.length > 12) {
      return res.status(400).json({ error: 'widgets must be an array of at most 12' });
    }
    const clean = [];
    for (const w of widgets) {
      if (!w || typeof w !== 'object') return res.status(400).json({ error: 'Each widget must be an object' });
      const title = typeof w.title === 'string' ? w.title.trim().slice(0, 80) : '';
      if (!title) return res.status(400).json({ error: 'Each widget needs a title' });
      if (!VIZ.has(w.viz)) return res.status(400).json({ error: `viz must be one of: ${[...VIZ].join(', ')}` });
      if (w.size !== undefined && !SIZES.has(w.size)) return res.status(400).json({ error: 'size must be half or full' });
      if (!w.query || typeof w.query !== 'object' || Array.isArray(w.query)) {
        return res.status(400).json({ error: 'Each widget needs a query object' });
      }
      // Size bound: a query is a small JSON body; 4KB each keeps the doc far
      // under Mongo's limits whatever twelve of them contain.
      if (JSON.stringify(w.query).length > 4096) {
        return res.status(400).json({ error: 'Widget query too large' });
      }
      clean.push({ title, viz: w.viz, size: SIZES.has(w.size) ? w.size : 'half', query: w.query });
    }
    await SavedDashboard.updateOne(
      { user: req.user.id },
      { $set: { widgets: clean, updatedAt: new Date() }, $setOnInsert: { user: req.user.id, createdAt: new Date() } },
      { upsert: true }
    );
    logAudit(req, 'analytics.dashboard_save', { type: 'dashboard', id: req.user.id }, { widgets: clean.length });
    res.json({ dashboard: { widgets: clean } });
  } catch (err) {
    next(err);
  }
});

router.get('/catalogue', async (req, res, next) => {
  try {
    const fields = await composeCatalogue(req.user.id);
    res.json({
      fields: fields.map((f) => ({
        key: f.key,
        label: f.label,
        domain: f.domain,
        type: f.type,
        unit: f.unit || null,
        role: f.role,
        aggregations: f.aggregations || [],
        sortable: !!f.sortable,
        groupable: !!f.groupable,
        filterable: !!f.filterable,
        ops: f.filterable ? opsForType(f.type) : [],
        enumOptions: f.enumOptions || undefined,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/query', async (req, res, next) => {
  try {
    const out = await runQuery(req.user.id, req.body || {});
    res.json(out);
  } catch (err) {
    if (err instanceof QueryError) {
      return res.status(err.status).json({ error: err.message });
    }
    // A pipeline exceeding maxTimeMS surfaces as a Mongo error — report it as
    // a bounded-query refusal, not a 500 (the cap working is not a fault).
    if (err && (err.codeName === 'MaxTimeMSExpired' || err.code === 50)) {
      return res.status(422).json({ error: 'Query took too long — narrow the scope or filters' });
    }
    next(err);
  }
});

module.exports = router;
