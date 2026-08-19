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
const SavedView = require('../models/SavedView');
const { logAudit } = require('../services/audit');

const router = express.Router();

router.use(requireAuth);

// ── Dashboards (#987, multi since the saved-views slice) ───────────────────
// Several NAMED dashboards per user; widgets' stored queries are DATA — the
// engine revalidates on every render, so nothing here re-knows its rules.
// The default 'My cellar' set still lives client-side for users with no row.

const VIZ = new Set(['kpi', 'bar', 'donut', 'line', 'table']);
const SIZES = new Set(['half', 'full']);
const MAX_DASHBOARDS = 8;
const MAX_VIEWS = 50;

/** Validate a widgets array; returns { clean } or { error }. */
function cleanWidgets(widgets) {
  if (!Array.isArray(widgets) || widgets.length > 12) {
    return { error: 'widgets must be an array of at most 12' };
  }
  const clean = [];
  for (const w of widgets) {
    if (!w || typeof w !== 'object') return { error: 'Each widget must be an object' };
    const title = typeof w.title === 'string' ? w.title.trim().slice(0, 80) : '';
    if (!title) return { error: 'Each widget needs a title' };
    if (!VIZ.has(w.viz)) return { error: `viz must be one of: ${[...VIZ].join(', ')}` };
    if (w.size !== undefined && !SIZES.has(w.size)) return { error: 'size must be half or full' };
    if (!w.query || typeof w.query !== 'object' || Array.isArray(w.query)) {
      return { error: 'Each widget needs a query object' };
    }
    // Size bound: 4KB each keeps the doc far under Mongo's limits.
    if (JSON.stringify(w.query).length > 4096) return { error: 'Widget query too large' };
    clean.push({ title, viz: w.viz, size: SIZES.has(w.size) ? w.size : 'half', query: w.query });
  }
  return { clean };
}

const cleanName = (raw, max, fallback) => {
  const s = typeof raw === 'string' ? raw.trim().slice(0, max) : '';
  return s || fallback;
};

router.get('/dashboards', async (req, res, next) => {
  try {
    const docs = await SavedDashboard.find({ user: req.user.id }).sort({ createdAt: 1 }).lean();
    res.json({ dashboards: docs.map((d) => ({ id: String(d._id), name: d.name, widgets: d.widgets, updatedAt: d.updatedAt })) });
  } catch (err) {
    next(err);
  }
});

router.post('/dashboards', async (req, res, next) => {
  try {
    const count = await SavedDashboard.countDocuments({ user: req.user.id });
    if (count >= MAX_DASHBOARDS) return res.status(400).json({ error: `At most ${MAX_DASHBOARDS} dashboards` });
    const { clean, error } = cleanWidgets(req.body?.widgets ?? []);
    if (error) return res.status(400).json({ error });
    const name = cleanName(req.body?.name, 60, 'My cellar');
    const doc = await SavedDashboard.create({ user: req.user.id, name, widgets: clean });
    logAudit(req, 'analytics.dashboard_create', { type: 'dashboard', id: doc._id }, { name, widgets: clean.length });
    res.status(201).json({ dashboard: { id: String(doc._id), name: doc.name, widgets: doc.widgets } });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'A dashboard with that name already exists' });
    next(err);
  }
});

router.put('/dashboards/:id', async (req, res, next) => {
  try {
    const doc = await SavedDashboard.findOne({ _id: req.params.id, user: req.user.id });
    if (!doc) return res.status(404).json({ error: 'Dashboard not found' });
    if (req.body?.widgets !== undefined) {
      const { clean, error } = cleanWidgets(req.body.widgets);
      if (error) return res.status(400).json({ error });
      doc.widgets = clean;
    }
    if (req.body?.name !== undefined) doc.name = cleanName(req.body.name, 60, doc.name);
    await doc.save();
    logAudit(req, 'analytics.dashboard_save', { type: 'dashboard', id: doc._id }, { name: doc.name, widgets: doc.widgets.length });
    res.json({ dashboard: { id: String(doc._id), name: doc.name, widgets: doc.widgets } });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'A dashboard with that name already exists' });
    next(err);
  }
});

router.delete('/dashboards/:id', async (req, res, next) => {
  try {
    const r = await SavedDashboard.deleteOne({ _id: req.params.id, user: req.user.id });
    if (!r.deletedCount) return res.status(404).json({ error: 'Dashboard not found' });
    logAudit(req, 'analytics.dashboard_delete', { type: 'dashboard', id: req.params.id }, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Saved views + preset stars ─────────────────────────────────────────────

router.get('/views', async (req, res, next) => {
  try {
    const docs = await SavedView.find({ user: req.user.id }).sort({ createdAt: 1 }).lean();
    res.json({
      views: docs.filter((d) => d.kind === 'own').map((d) => ({
        id: String(d._id), name: d.name, starred: !!d.starred, viz: d.viz, query: d.query,
      })),
      starredPresets: docs.filter((d) => d.kind === 'preset-star').map((d) => d.presetKey),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/views', async (req, res, next) => {
  try {
    const count = await SavedView.countDocuments({ user: req.user.id, kind: 'own' });
    if (count >= MAX_VIEWS) return res.status(400).json({ error: `At most ${MAX_VIEWS} saved views` });
    const name = cleanName(req.body?.name, 80, '');
    if (!name) return res.status(400).json({ error: 'A view needs a name' });
    if (!req.body?.query || typeof req.body.query !== 'object' || Array.isArray(req.body.query)) {
      return res.status(400).json({ error: 'A view needs a query object' });
    }
    if (JSON.stringify(req.body.query).length > 4096) return res.status(400).json({ error: 'View query too large' });
    const viz = VIZ.has(req.body?.viz) ? req.body.viz : 'table';
    const doc = await SavedView.create({
      user: req.user.id, kind: 'own', name, viz, query: req.body.query, starred: !!req.body?.starred,
    });
    logAudit(req, 'analytics.view_save', { type: 'saved-view', id: doc._id }, { name });
    res.status(201).json({ view: { id: String(doc._id), name: doc.name, starred: doc.starred, viz: doc.viz, query: doc.query } });
  } catch (err) {
    next(err);
  }
});

router.put('/views/:id', async (req, res, next) => {
  try {
    const doc = await SavedView.findOne({ _id: req.params.id, user: req.user.id, kind: 'own' });
    if (!doc) return res.status(404).json({ error: 'View not found' });
    if (req.body?.name !== undefined) doc.name = cleanName(req.body.name, 80, doc.name);
    if (req.body?.starred !== undefined) doc.starred = !!req.body.starred;
    if (req.body?.viz !== undefined && VIZ.has(req.body.viz)) doc.viz = req.body.viz;
    if (req.body?.query !== undefined) {
      if (!req.body.query || typeof req.body.query !== 'object' || Array.isArray(req.body.query)) {
        return res.status(400).json({ error: 'query must be an object' });
      }
      if (JSON.stringify(req.body.query).length > 4096) return res.status(400).json({ error: 'View query too large' });
      doc.query = req.body.query;
      doc.markModified('query');
    }
    await doc.save();
    res.json({ view: { id: String(doc._id), name: doc.name, starred: doc.starred, viz: doc.viz, query: doc.query } });
  } catch (err) {
    next(err);
  }
});

router.delete('/views/:id', async (req, res, next) => {
  try {
    const r = await SavedView.deleteOne({ _id: req.params.id, user: req.user.id, kind: 'own' });
    if (!r.deletedCount) return res.status(404).json({ error: 'View not found' });
    logAudit(req, 'analytics.view_delete', { type: 'saved-view', id: req.params.id }, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// The built-in preset keys, mirrored from frontend/src/utils/analyticsPresets.js
// (audit 2026-08-19 F7: an unvalidated presetKey allowed unbounded row
// creation under arbitrary strings). Keep in sync when presets change — a
// missing key here means "cannot star that preset", never data damage.
const ANALYTICS_PRESET_KEYS = new Set([
  'moneyByRegion', 'favouriteRegions', 'cellarByType', 'whatIDrink', 'agingRunway',
  'pastWindow', 'forgottenBottles', 'whereIShop', 'giftedVsDrunk',
  'vintageSpread', 'topProducers', 'drankLastYear', 'drinkSoon', 'priciest',
]);

// Toggle a star on a BUILT-IN preset: existence of the row is the star.
router.post('/views/star-preset', async (req, res, next) => {
  try {
    const presetKey = cleanName(req.body?.presetKey, 60, '');
    if (!presetKey) return res.status(400).json({ error: 'presetKey required' });
    if (!ANALYTICS_PRESET_KEYS.has(presetKey)) return res.status(400).json({ error: 'Unknown preset' });
    const existing = await SavedView.findOne({ user: req.user.id, kind: 'preset-star', presetKey });
    if (existing) {
      await SavedView.deleteOne({ _id: existing._id });
      return res.json({ starred: false, presetKey });
    }
    await SavedView.create({ user: req.user.id, kind: 'preset-star', presetKey });
    res.json({ starred: true, presetKey });
  } catch (err) {
    if (err && err.code === 11000) return res.json({ starred: true, presetKey: req.body?.presetKey });
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
