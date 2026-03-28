const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const WineReport = require('../models/WineReport');
const WineDefinition = require('../models/WineDefinition');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { stripHtml } = require('../utils/sanitize');

const VALID_REASONS = ['wrong_info', 'duplicate', 'inappropriate', 'other'];

// POST /api/wine-reports — report a wine
router.post('/', requireAuth, async (req, res) => {
  try {
    const { wineDefinitionId, reason, details, duplicateOfId } = req.body;

    if (!wineDefinitionId || !mongoose.Types.ObjectId.isValid(wineDefinitionId)) {
      return res.status(400).json({ error: 'Invalid wineDefinitionId' });
    }
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'Invalid reason' });
    }
    if (details && details.trim().length > 2000) {
      return res.status(400).json({ error: 'Details must be 2000 characters or fewer' });
    }

    const wine = await WineDefinition.findById(wineDefinitionId).lean();
    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    // Prevent duplicate reports from the same user for the same wine
    const existing = await WineReport.findOne({
      user: req.user.id,
      wineDefinition: wineDefinitionId,
      status: 'pending'
    });
    if (existing) {
      return res.status(409).json({ error: 'You already have a pending report for this wine' });
    }

    const report = await WineReport.create({
      user: req.user.id,
      wineDefinition: wineDefinitionId,
      reason,
      details: details ? stripHtml(details) : undefined,
      duplicateOf: duplicateOfId || undefined
    });

    logAudit(req, 'wine.report.created', { type: 'WineReport', id: report._id }, {
      wineDefinitionId,
      reason
    });

    res.status(201).json({ report });
  } catch (err) {
    console.error('Create wine report error:', err);
    res.status(500).json({ error: 'Failed to create wine report' });
  }
});

// GET /api/wine-reports/my — list the authenticated user's own wine reports
router.get('/my', requireAuth, async (req, res) => {
  try {
    const reports = await WineReport.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .populate('wineDefinition', 'name producer')
      .populate('duplicateOf', 'name producer')
      .lean();

    res.json({ reports });
  } catch (err) {
    console.error('Get my wine reports error:', err);
    res.status(500).json({ error: 'Failed to get wine reports' });
  }
});

module.exports = router;
