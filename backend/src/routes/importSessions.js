// Import draft sessions: /api/bottles/import/sessions.
//
// A draft holds a reviewed import that is not confirmed yet, so the user can
// leave and resume it: the parsed rows, what was chosen for each, the rack
// plan and the parse warnings. One draft per user and cellar.
//
// Mounted by routes/import.js after its requireAuth and requireNonDemo, so
// every handler here runs for a signed-in, non-demo user.

const express = require('express');
const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const ImportSession = require('../models/ImportSession');
const { getCellarRole } = require('../utils/cellarAccess');
// Parse-time warnings are bounded before they are stored.
const { sanitizeImportWarnings } = require('../utils/importWarnings');
const { findWineMatches } = require('../services/importMatching');
const { IMPORT_EXACT_THRESHOLD } = require('../config/constants');

const router = express.Router();

// The score at or above which a match is taken as the same wine.
const EXACT_THRESHOLD = IMPORT_EXACT_THRESHOLD;

/**
 * POST /api/bottles/import/sessions
 *
 * Creates (or replaces) the user's draft session for a cellar.
 * One draft per user+cellar — the old one is deleted before creating the new one
 * so stale sessions don't accumulate.
 */
router.post('/sessions', async (req, res) => {
  try {
    const { cellarId, fileName, detectedFormat, results, selections, manualWines, positionAnchor, rackConfigs, defaultCurrency, importWarnings, detectedEncoding, ctTable, ctTextFallback } = req.body;

    if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Valid cellarId is required' });
    }
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'results array is required' });
    }

    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    // No role answers like a missing cellar (no existence oracle), as
    // middleware/cellarAccess does; a viewer sees the cellar but cannot import.
    const role = getCellarRole(cellar, req.user.id);
    if (!role) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    if (role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to import bottles to this cellar' });
    }

    // Replace any existing draft for this user+cellar
    await ImportSession.deleteMany({ cellar: cellarId, user: req.user.id, status: 'draft' });

    const session = new ImportSession({
      cellar: cellarId,
      user: req.user.id,
      fileName,
      detectedFormat,
      results,
      selections: selections || {},
      manualWines: manualWines || {},
      positionAnchor: positionAnchor || 'top-left',
      rackConfigs: rackConfigs || {},
      defaultCurrency: defaultCurrency || 'USD',
      importWarnings: sanitizeImportWarnings(importWarnings),
      detectedEncoding: detectedEncoding || undefined,
      ctTable: ctTable || undefined,
      ctTextFallback: Array.isArray(ctTextFallback) ? ctTextFallback : []
    });
    await session.save();

    res.status(201).json({ sessionId: session._id });
  } catch (err) {
    console.error('Create import session error:', err);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

/**
 * GET /api/bottles/import/sessions?cellarId=...
 *
 * Lists draft sessions for the authenticated user in a cellar.
 */
router.get('/sessions', async (req, res) => {
  try {
    const { cellarId } = req.query;
    if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Valid cellarId is required' });
    }

    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    // No role answers like a missing cellar (no existence oracle), as
    // middleware/cellarAccess does. A viewer may list their own drafts.
    if (!getCellarRole(cellar, req.user.id)) {
      return res.status(404).json({ error: 'Cellar not found' });
    }

    const sessions = await ImportSession.find({
      cellar: cellarId,
      user: req.user.id,
      status: 'draft'
    })
      .select('fileName detectedFormat createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ sessions });
  } catch (err) {
    console.error('List import sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * GET /api/bottles/import/sessions/:id
 *
 * Loads a draft session.  For any item whose selection is 'request', re-runs wine
 * matching — if a wine has since been added to the library (e.g. admin resolved the
 * request), the new match is returned in `refreshed` so the frontend can update the
 * selection automatically.
 */
router.get('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id).lean();
    if (!session || session.status !== 'draft') {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Re-match items that were marked 'request' to detect wines added since last save
    const refreshed = {}; // { [index]: match object }
    const requestedIndices = Object.entries(session.selections || {})
      .filter(([, sel]) => sel === 'request')
      .map(([idx]) => Number(idx));

    for (const idx of requestedIndices) {
      const result = (session.results || []).find(r => r.index === idx);
      if (!result?.item) continue;
      try {
        const matches = await findWineMatches(result.item, { userId: req.user.id, roles: req.user.roles });
        // Same styleConflict + colourConflict gates as Pass 1a: this path
        // silently re-points a row the user marked 'request', so a range
        // sibling or the other colour of a pair must never pass.
        if (matches.length > 0 && matches[0].score >= EXACT_THRESHOLD && !matches[0].styleConflict && !matches[0].colourConflict) {
          const m = matches[0];
          refreshed[idx] = {
            wineId: m.wine._id,
            name: m.wine.name,
            producer: m.wine.producer,
            country: m.wine.country?.name || null,
            region: m.wine.region?.name || null,
            appellation: m.wine.appellation || null,
            type: m.wine.type,
            score: Math.round(m.score * 100) / 100
          };
        }
      } catch (err) {
        console.error('Failed to re-match import session item (non-fatal):', err.message);
      }
    }

    res.json({ session, refreshed });
  } catch (err) {
    console.error('Load import session error:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

/**
 * PUT /api/bottles/import/sessions/:id
 *
 * Updates selections and/or manualWines for an existing draft session.
 */
router.put('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id);
    if (!session || session.status !== 'draft') {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { results, selections, manualWines, positionAnchor, rackConfigs, defaultCurrency, importWarnings, detectedEncoding, ctTable, ctTextFallback } = req.body;
    // Results change when a per-row AI look-up rewrites a row — persist them
    // so a resumed session doesn't show stale "No match found" rows whose
    // selection references a wine absent from the stored matches.
    if (Array.isArray(results)) session.results = results;
    if (selections !== undefined) session.selections = selections;
    if (manualWines !== undefined) session.manualWines = manualWines;
    if (positionAnchor !== undefined) session.positionAnchor = positionAnchor;
    if (rackConfigs !== undefined) session.rackConfigs = rackConfigs;
    if (defaultCurrency !== undefined) session.defaultCurrency = defaultCurrency;
    // Parse-time notices/metadata — persisted so the ct-truncated banner (and
    // the encoding/table/fallback notes) survive a resume.
    if (importWarnings !== undefined) session.importWarnings = sanitizeImportWarnings(importWarnings);
    if (detectedEncoding !== undefined) session.detectedEncoding = detectedEncoding;
    if (ctTable !== undefined) session.ctTable = ctTable;
    if (ctTextFallback !== undefined) session.ctTextFallback = ctTextFallback;
    await session.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('Update import session error:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

/**
 * DELETE /api/bottles/import/sessions/:id
 *
 * Deletes a session (called after a successful import).
 */
router.delete('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await session.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete import session error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

module.exports = router;
