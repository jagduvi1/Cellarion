/**
 * /api/somm/pending-wines — the pending-identity curation queue.
 *
 *   GET  /            — newest first, paged. ?createdVia=ui|import|mcp|ai
 *                       narrows a burst (a 500-row CSV is one 'import' sweep).
 *                       ?includeUnavailable=1 also lists the rows dispositioned
 *                       "no producer on the label" (excluded by default: this
 *                       queue is a list of WORK). ?kind=needs_check lists
 *                       only the wines from a member's file that wait for a
 *                       curator's check, oldest first; ?kind=needs_identity
 *                       only the incomplete ones. Envelope: { wines, total,
 *                       page, pages, pendingTotal, unavailableTotal,
 *                       uncheckedTotal }.
 *                       ANONYMISED: no creator id, username or email — a
 *                       curator fixes a record, not a person.
 *   PATCH /:id        — { producer?, name?, appellation?, regionName?,
 *                       countryName?, grapeNames?[], type?,
 *                       identityUnavailable?, crossFieldOverride? }.
 *                       crossFieldOverride is not a field: it forces through a
 *                       producer the cross-field rules refuse (a user-minted
 *                       Region/Appellation carrying a real producer's name),
 *                       and is recorded in the audit entry with the rules it
 *                       overrode. Only rows that
 *                       are STILL pending may be edited; an already-completed
 *                       wine is a 409 (the id is real — say so) and a missing
 *                       one a 404. Completing producer + name promotes the row
 *                       automatically (the WineDefinition pre-validate hook)
 *                       and runs the search/embedding/maturity follow-through.
 *                       A 409 for a duplicate carries `duplicate`: the wine
 *                       it collided with.
 *   POST /:id/merge   — { intoWineId }: the row is a wine the registry
 *                       already holds; its bottles move onto that published
 *                       wine and the row is removed. MCP twin:
 *                       merge_pending_wine.
 *
 * Somm-or-admin, like every other /api/somm route. The global writeLimiter in
 * app.js already rate-limits the PATCH (it applies to every non-GET under
 * /api/), so no route-local limiter is added — one definition of the write
 * budget, tunable in one place.
 *
 * Validation, taxonomy resolution and the promotion follow-through live in
 * services/pendingWineOps — shared with the MCP tools so REST and MCP cannot
 * drift (same pattern as ownerInquiryOps / wineProfileOps).
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireSommOrAdmin } = require('../../middleware/auth');
const { logAudit } = require('../../services/audit');
const { parsePagination } = require('../../utils/pagination');
const { coerceStringQuery } = require('../../utils/validation');
const asyncHandler = require('../../utils/asyncHandler');
const {
  queryPendingWines,
  validatePendingFix,
  applyPendingFix,
  mergePendingInto,
  loadPendingWine,
  CREATED_VIA_FILTERS,
  FIXABLE_FIELDS,
} = require('../../services/pendingWineOps');

router.use(requireAuth, requireSommOrAdmin);

// GET /api/somm/pending-wines?page=&limit=&createdVia=
router.get('/', async (req, res) => {
  try {
    const { limit, offset, page } = parsePagination(req.query, { limit: 20, maxLimit: 100 });
    const { rows, total, pendingTotal, unavailableTotal, uncheckedTotal } = await queryPendingWines({
      limit,
      offset,
      createdVia: req.query.createdVia,
      kind: coerceStringQuery(req.query.kind),
      includeUnavailable: req.query.includeUnavailable === '1' || req.query.includeUnavailable === 'true',
    });
    res.json({
      wines: rows,
      total,
      page,
      pages: Math.ceil(total / limit),
      pendingTotal,
      unavailableTotal,
      uncheckedTotal,
      // So the UI can build the filter without a second copy of the list.
      createdViaOptions: CREATED_VIA_FILTERS,
      fixableFields: FIXABLE_FIELDS,
    });
  } catch (err) {
    console.error('List pending wines error:', err);
    res.status(500).json({ error: 'Failed to list pending wines' });
  }
});

// PATCH /api/somm/pending-wines/:id
router.patch('/:id', async (req, res) => {
  try {
    const check = validatePendingFix(req.body);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const loaded = await loadPendingWine(req.params.id);
    if (!loaded.ok) {
      const status = loaded.code === 'not_found' ? 404 : loaded.code === 'conflict' ? 409 : 400;
      return res.status(status).json({ error: loaded.message });
    }

    const applied = await applyPendingFix(loaded.wine, check.clean, req.user.id);
    if (!applied.ok) {
      const status = applied.code === 'conflict' ? 409 : 400;
      return res.status(status).json({ error: applied.message, ...(applied.duplicate ? { duplicate: applied.duplicate } : {}) });
    }
    const { wine, promoted, diff, crossFieldOverridden } = applied;

    logAudit(req, 'wine.pending_fix', { type: 'wine', id: wine._id }, {
      fields: Object.keys(check.clean),
      diff,
      promoted,
      // Only present when a curator actually overrode a cross-field refusal —
      // with the rules and matched strings, so the decision is reviewable
      // afterwards rather than a bare boolean.
      ...(crossFieldOverridden ? { crossFieldOverridden } : {}),
    });

    res.json({
      message: promoted
        ? 'Identity completed — the wine is now visible in the registry'
        : 'Saved — the wine still needs a producer and a name to leave the queue',
      promoted,
      wine: {
        _id: wine._id,
        name: wine.name,
        producer: wine.producer || null,
        appellation: wine.appellation || null,
        type: wine.type || null,
        pendingIdentity: wine.pendingIdentity === true,
        identityUnavailable: wine.identityUnavailable === true,
      },
    });
  } catch (err) {
    console.error('Fix pending wine error:', err);
    res.status(500).json({ error: 'Failed to update the wine' });
  }
});

// POST /api/somm/pending-wines/:id/merge — body { intoWineId }.
const MERGE_STATUS = { not_found: 404, conflict: 409, invalid_input: 400 };
router.post('/:id/merge', asyncHandler(async (req, res) => {
  const loaded = await loadPendingWine(req.params.id);
  if (!loaded.ok) return res.status(MERGE_STATUS[loaded.code] || 400).json({ error: loaded.message });

  const merged = await mergePendingInto(loaded.wine, req.body?.intoWineId, { req });
  if (!merged.ok) return res.status(MERGE_STATUS[merged.code] || 400).json({ error: merged.message });

  const { target, bottlesMoved } = merged;
  res.json({
    mergedWineId: req.params.id,
    intoWineId: String(target._id),
    into: { producer: target.producer || null, name: target.name },
    bottlesMoved,
    message: `Merged into ${[target.producer, target.name].filter(Boolean).join(' — ')}.`,
  });
}));

module.exports = router;
