const express = require('express');
const router = express.Router();
const WineReport = require('../../models/WineReport');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const searchService = require('../../services/search');
const { generateWineKey, normalizeAppellation, stripTrailingVintage } = require('../../utils/normalize');
const { canonicalizeWineName } = require('../../utils/producerPrefix');
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../services/audit');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');
const { closeWineReport, validateResponse } = require('../../services/wineReportOps');

// Close outcomes map onto HTTP the same way on both routes.
const CLOSE_STATUS = { invalid_input: 400, not_found: 404, conflict: 400 };

const REPORT_STATUSES = ['pending', 'resolved', 'dismissed'];
// Keep in sync with the WineReport schema enum (models/WineReport.js)
const REPORT_REASONS = ['wrong_info', 'duplicate', 'inappropriate', 'wrong_price', 'wrong_tasting_profile', 'other'];

router.use(requireAuth, requireRole('admin'));

// GET /api/admin/wine-reports — list all wine reports
router.get('/', async (req, res) => {
  try {
    const { status, reason } = req.query;
    const { limit, offset, page } = parsePagination(req.query, { limit: 20, maxLimit: 200 });

    // Retrieve from static arrays so values in the filter are never user-tainted
    const statusIdx = REPORT_STATUSES.indexOf(String(status || ''));
    const reasonIdx = REPORT_REASONS.indexOf(String(reason || ''));
    const filter = {};
    if (statusIdx !== -1) filter.status = REPORT_STATUSES[statusIdx];
    if (reasonIdx !== -1) filter.reason = REPORT_REASONS[reasonIdx];

    const [reports, total] = await Promise.all([
      WineReport.find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate('user', 'username email')
        .populate({ path: 'wineDefinition', select: 'name producer country type appellation', populate: { path: 'country', select: 'name' } })
        .populate('duplicateOf', 'name producer')
        .populate('resolvedBy', 'username')
        .lean(),
      WineReport.countDocuments(filter)
    ]);

    res.json({ reports, total, page, limit });
  } catch (err) {
    console.error('Admin list wine reports error:', err);
    res.status(500).json({ error: 'Failed to list wine reports' });
  }
});

// PUT /api/admin/wine-reports/:id/resolve — mark a wine report as resolved.
// Body: { response?, applySuggestion?: true }
//
// applySuggestion (R7): when the report carries a structured correction and
// the admin agrees, resolving APPLIES it to the wine in the same action —
// before this, resolution wrote nothing back and the admin re-typed the fix
// in Admin → Wines (or, in practice, didn't). Applied via .save() so the
// model hooks run (canonicalKey recompute + verifiedChecks invalidation),
// with normalizedKey recomputed the same way the admin edit route does; a
// unique-key collision means the correction would make this wine identical
// to an existing one — that is a MERGE, refused here with a clear 409.
router.put('/:id/resolve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { response, applySuggestion } = req.body;

    // BEFORE applySuggestion writes the wine — otherwise a rejected reply
    // leaves the registry edited with the report still open.
    const checked = validateResponse(response);
    if (!checked.ok) return res.status(400).json({ error: checked.message });

    const report = await WineReport.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.status !== 'pending') {
      return res.status(400).json({ error: 'Report is already resolved or dismissed' });
    }

    let applied = null;
    if (applySuggestion) {
      if (!report.suggestedField || !report.suggestedValue) {
        return res.status(400).json({ error: 'This report has no structured suggestion to apply' });
      }
      const wine = await WineDefinition.findById(report.wineDefinition);
      if (!wine) return res.status(404).json({ error: 'The reported wine no longer exists' });

      const previous = wine[report.suggestedField] ?? null;
      // Run the suggestion through the SAME field normalizers the write
      // pipeline applies — a raw assignment would let a one-click apply
      // reintroduce the exact defect classes the registry campaign closed:
      // tier-suffixed appellations, trailing vintages, producer-in-name
      // embeds (audit 2026-07-29 R7-#1). The reporter's text is untrusted
      // input that merely happens to arrive via an admin's click.
      let value = report.suggestedValue.trim().replace(/\s+/g, ' ');
      if (report.suggestedField === 'name') {
        value = canonicalizeWineName(stripTrailingVintage(value), wine.producer);
      } else if (report.suggestedField === 'appellation') {
        value = await resolveCanonicalAppellation(normalizeAppellation(value));
      }
      wine[report.suggestedField] = value;
      if (report.suggestedField !== 'type') {
        wine.normalizedKey = generateWineKey(wine.name, wine.producer, wine.appellation);
      }
      try {
        await wine.save();
      } catch (err) {
        if (err.code === 11000) {
          return res.status(409).json({
            error: 'Applying this correction would make the wine identical to an existing registry wine — merge them in Admin → Wines instead',
          });
        }
        throw err;
      }
      searchService.indexWine(wine._id).catch(() => {});
      // Bottles denormalize wineName/producer/appellation into their own
      // search index — without this, cellar search matches the OLD values
      // indefinitely (mirrors the admin wine-edit route; audit R7-#3).
      Bottle.distinct('_id', { wineDefinition: wine._id })
        .then(ids => searchService.bulkIndexBottles(ids))
        .catch(() => {});
      applied = { field: report.suggestedField, from: previous, to: report.suggestedValue };
      logAudit(req, 'admin.wine.update',
        { type: 'wine', id: wine._id },
        { via: 'wine-report', field: applied.field, from: applied.from, to: applied.to });
    }

    const closed = await closeWineReport({
      report, actorId: req.user.id, outcome: 'resolved', response, req, via: 'rest',
    });
    if (!closed.ok) return res.status(CLOSE_STATUS[closed.code] || 400).json({ error: closed.message });

    res.json({ report: closed.report, applied });
  } catch (err) {
    console.error('Admin resolve wine report error:', err);
    res.status(500).json({ error: 'Failed to resolve wine report' });
  }
});

// PUT /api/admin/wine-reports/:id/dismiss — dismiss a wine report
router.put('/:id/dismiss', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { response } = req.body;

    const closed = await closeWineReport({
      reportId: req.params.id, actorId: req.user.id, outcome: 'dismissed', response, req, via: 'rest',
    });
    if (!closed.ok) return res.status(CLOSE_STATUS[closed.code] || 400).json({ error: closed.message });

    res.json({ report: closed.report });
  } catch (err) {
    console.error('Admin dismiss wine report error:', err);
    res.status(500).json({ error: 'Failed to dismiss wine report' });
  }
});

module.exports = router;
