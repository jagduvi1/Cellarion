const express = require('express');
const router = express.Router();
const WineReport = require('../../models/WineReport');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../services/audit');
const { stripHtml } = require('../../utils/sanitize');
const { incrementCred } = require('../../utils/cellarCred');
const { parsePagination } = require('../../utils/pagination');

const REPORT_STATUSES = ['pending', 'resolved', 'dismissed'];
const REPORT_REASONS = ['wrong_info', 'duplicate', 'inappropriate', 'wrong_price', 'other'];

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
        .populate('wineDefinition', 'name producer country type')
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

// GET /api/admin/wine-reports/:id — get single report
router.get('/:id', async (req, res) => {
  try {
    const report = await WineReport.findById(req.params.id)
      .populate('user', 'username email')
      .populate('wineDefinition', 'name producer country type appellation')
      .populate('duplicateOf', 'name producer')
      .populate('resolvedBy', 'username')
      .lean();

    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ report });
  } catch (err) {
    console.error('Admin get wine report error:', err);
    res.status(500).json({ error: 'Failed to get wine report' });
  }
});

// PUT /api/admin/wine-reports/:id/resolve — mark a wine report as resolved
router.put('/:id/resolve', async (req, res) => {
  try {
    const { adminNotes } = req.body;

    const report = await WineReport.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.status !== 'pending') {
      return res.status(400).json({ error: 'Report is already resolved or dismissed' });
    }

    report.status = 'resolved';
    report.adminNotes = adminNotes ? stripHtml(adminNotes) : undefined;
    report.resolvedBy = req.user.id;
    report.resolvedAt = new Date();
    await report.save();

    // Award Cellar Cred to the reporter
    incrementCred(report.user, 'wine_report_resolved').catch(() => {});

    logAudit(req, 'wine.report.resolved', { type: 'WineReport', id: report._id }, {
      wineDefinitionId: report.wineDefinition
    });

    await report.populate('user', 'username email');
    await report.populate('wineDefinition', 'name producer country type');
    await report.populate('resolvedBy', 'username');
    res.json({ report });
  } catch (err) {
    console.error('Admin resolve wine report error:', err);
    res.status(500).json({ error: 'Failed to resolve wine report' });
  }
});

// PUT /api/admin/wine-reports/:id/dismiss — dismiss a wine report
router.put('/:id/dismiss', async (req, res) => {
  try {
    const { adminNotes } = req.body;

    const report = await WineReport.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.status !== 'pending') {
      return res.status(400).json({ error: 'Report is already resolved or dismissed' });
    }

    report.status = 'dismissed';
    report.adminNotes = adminNotes ? stripHtml(adminNotes) : undefined;
    report.resolvedBy = req.user.id;
    report.resolvedAt = new Date();
    await report.save();

    logAudit(req, 'wine.report.dismissed', { type: 'WineReport', id: report._id }, {
      wineDefinitionId: report.wineDefinition
    });

    await report.populate('user', 'username email');
    await report.populate('wineDefinition', 'name producer country type');
    await report.populate('resolvedBy', 'username');
    res.json({ report });
  } catch (err) {
    console.error('Admin dismiss wine report error:', err);
    res.status(500).json({ error: 'Failed to dismiss wine report' });
  }
});

module.exports = router;
