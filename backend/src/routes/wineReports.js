const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const WineReport = require('../models/WineReport');
const WineDefinition = require('../models/WineDefinition');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { stripHtml } = require('../utils/sanitize');

const VALID_REASONS = ['wrong_info', 'duplicate', 'inappropriate', 'wrong_price', 'wrong_tasting_profile', 'other'];

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
    // duplicateOfId is optional, but if supplied it must be a valid ObjectId —
    // otherwise it was persisted unchecked (CastError 500 + a dangling ref).
    if (duplicateOfId != null && duplicateOfId !== '' && !mongoose.Types.ObjectId.isValid(duplicateOfId)) {
      return res.status(400).json({ error: 'Invalid duplicateOfId' });
    }
    if (details && details.trim().length > 2000) {
      return res.status(400).json({ error: 'Details must be 2000 characters or fewer' });
    }

    const wine = await WineDefinition.findById(wineDefinitionId).lean();
    if (!wine) {
      return res.status(404).json({ error: 'Wine not found' });
    }

    // Use a typed ObjectId in the queries below so a user-supplied value can
    // never be interpreted as a query operator (NoSQL injection). Safe — the
    // id was validated as a real ObjectId above.
    const wineRef = new mongoose.Types.ObjectId(wineDefinitionId);

    // Prevent duplicate reports of the SAME issue from the same user, but allow
    // separate pending reports for different reasons on the same wine (e.g. a
    // wrong price AND an incorrect tasting profile).
    const existing = await WineReport.findOne({
      user: req.user.id,
      wineDefinition: wineRef,
      reason,
      status: 'pending'
    });
    if (existing) {
      return res.status(409).json({ error: 'You already have a pending report of this type for this wine' });
    }

    const report = await WineReport.create({
      user: req.user.id,
      wineDefinition: wineRef,
      reason,
      details: details ? stripHtml(details) : undefined,
      duplicateOf: (duplicateOfId && mongoose.Types.ObjectId.isValid(duplicateOfId)) ? duplicateOfId : undefined
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
