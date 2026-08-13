const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const WineReport = require('../models/WineReport');
const WineDefinition = require('../models/WineDefinition');
const { findVisibleWine } = require('../services/wineVisibility');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { stripHtml } = require('../utils/sanitize');

const VALID_REASONS = ['wrong_info', 'duplicate', 'inappropriate', 'wrong_price', 'wrong_tasting_profile', 'other'];

// POST /api/wine-reports — report a wine
// requireNonDemo: wine reports enter the admin moderation queue — demo accounts
// must not spam it (same class as the guarded wine-requests route).
router.post('/', requireAuth, requireNonDemo, async (req, res) => {
  try {
    const { wineDefinitionId, reason, details, duplicateOfId, suggestedField, suggestedValue } = req.body;

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
    // Structured correction (R7): both-or-neither, appliable fields only.
    const SUGGESTABLE = ['name', 'producer', 'appellation', 'type'];
    const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
    const hasField = suggestedField != null && suggestedField !== '';
    const hasValue = typeof suggestedValue === 'string' && suggestedValue.trim() !== '';
    if (hasField !== hasValue) {
      return res.status(400).json({ error: 'A suggested correction needs both the field and the new value' });
    }
    // The frontend only offers the suggestion inputs for wrong_info, but a
    // client is not a trust boundary — and stale state CAN leak a suggestion
    // onto another reason (audit 2026-07-29 R7-#5). Enforce the pairing here.
    if (hasField && reason !== 'wrong_info') {
      return res.status(400).json({ error: 'A suggested correction is only valid with the "wrong info" reason' });
    }
    if (hasField) {
      if (!SUGGESTABLE.includes(suggestedField)) {
        return res.status(400).json({ error: `suggestedField must be one of: ${SUGGESTABLE.join(', ')}` });
      }
      if (suggestedValue.trim().length > 200) {
        return res.status(400).json({ error: 'Suggested value must be 200 characters or fewer' });
      }
      if (suggestedField === 'type' && !WINE_TYPES.includes(suggestedValue.trim())) {
        return res.status(400).json({ error: `Type must be one of: ${WINE_TYPES.join(', ')}` });
      }
    }

    // Visible-to-this-user, not merely existing (services/wineVisibility) —
    // a stranger must not be able to confirm a pending row exists by reporting
    // a correction to it. Its creator still can: their row is the one most
    // likely to need one.
    const wine = await findVisibleWine(wineDefinitionId, {
      userId: req.user.id, roles: req.user.roles, lean: true,
    });
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
      duplicateOf: (duplicateOfId && mongoose.Types.ObjectId.isValid(duplicateOfId)) ? duplicateOfId : undefined,
      suggestedField: hasField ? suggestedField : undefined,
      // Collapse internal whitespace/newlines too — this string is destined
      // for a registry field that feeds titles and JSON-LD, where an embedded
      // newline corrupts rendering (stripHtml only strips tags + ends).
      suggestedValue: hasField ? stripHtml(suggestedValue.trim().replace(/\s+/g, ' ')) : undefined
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
    // Explicit projection: this route used to return the whole document, so
    // every field added to the schema became user-visible by default. Name
    // what the reporter gets so a future internal field is opt-in, not opt-out.
    const reports = await WineReport.find({ user: req.user.id })
      .select('wineDefinition duplicateOf reason details suggestedField suggestedValue status adminResponse respondedAt createdAt')
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
