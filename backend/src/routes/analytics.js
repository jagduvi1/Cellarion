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

const router = express.Router();

router.use(requireAuth);

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
