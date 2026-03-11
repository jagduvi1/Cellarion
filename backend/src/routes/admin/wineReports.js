const express = require('express');
const router = express.Router();
const WineReport = require('../../models/WineReport');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../services/audit');

router.use(requireAuth, requireRole('admin'));

// GET /api/admin/wine-reports — list all wine reports
router.get('/', async (req, res) => {
  const { status, reason, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = {};
  if (status) filter.status = status;
  if (reason) filter.reason = reason;

  const [reports, total] = await Promise.all([
    WineReport.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('user', 'username email')
      .populate('wineDefinition', 'name producer country type')
      .populate('duplicateOf', 'name producer')
      .populate('resolvedBy', 'username')
      .lean(),
    WineReport.countDocuments(filter)
  ]);

  res.json({ reports, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/admin/wine-reports/:id — get single report
router.get('/:id', async (req, res) => {
  const report = await WineReport.findById(req.params.id)
    .populate('user', 'username email')
    .populate('wineDefinition', 'name producer country type appellation')
    .populate('duplicateOf', 'name producer')
    .populate('resolvedBy', 'username')
    .lean();

  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json({ report });
});

// PUT /api/admin/wine-reports/:id/resolve — mark a wine report as resolved
router.put('/:id/resolve', async (req, res) => {
  const { adminNotes } = req.body;

  const report = await WineReport.findById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.status !== 'pending') {
    return res.status(400).json({ error: 'Report is already resolved or dismissed' });
  }

  report.status = 'resolved';
  report.adminNotes = adminNotes ? adminNotes.trim() : undefined;
  report.resolvedBy = req.user.id;
  report.resolvedAt = new Date();
  await report.save();

  logAudit(req, 'wine.report.resolved', { type: 'WineReport', id: report._id }, {
    wineDefinitionId: report.wineDefinition
  });

  await report.populate('user', 'username email');
  await report.populate('wineDefinition', 'name producer country type');
  await report.populate('resolvedBy', 'username');
  res.json({ report });
});

// PUT /api/admin/wine-reports/:id/dismiss — dismiss a wine report
router.put('/:id/dismiss', async (req, res) => {
  const { adminNotes } = req.body;

  const report = await WineReport.findById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.status !== 'pending') {
    return res.status(400).json({ error: 'Report is already resolved or dismissed' });
  }

  report.status = 'dismissed';
  report.adminNotes = adminNotes ? adminNotes.trim() : undefined;
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
});

module.exports = router;
