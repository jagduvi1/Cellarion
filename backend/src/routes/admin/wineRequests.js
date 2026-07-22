const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const WineRequest = require('../../models/WineRequest');
const WineDefinition = require('../../models/WineDefinition');
const Bottle = require('../../models/Bottle');
const { generateWineKey, normalizeAppellation } = require('../../utils/normalize');
const { canonicalizeWineName } = require('../../utils/producerPrefix');
const Country = require('../../models/Country');
const { findOrCreateWine } = require('../../services/findOrCreateWine');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { createNotification } = require('../../services/notifications');
const { stripHtml } = require('../../utils/sanitize');
const { incrementCred } = require('../../utils/cellarCred');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');
const { ensurePendingVintageProfile } = require('../../utils/vintageProfile');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/wine-requests - List all wine requests
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const { limit, offset: skip } = parsePagination(req.query, { limit: 50, maxLimit: 200 });
    const filter = {};
    const VALID_STATUSES = ['pending', 'resolved', 'rejected'];

    if (status) {
      if (!VALID_STATUSES.includes(String(status))) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      filter.status = String(status);
    }

    const [requests, total] = await Promise.all([
      WineRequest.find(filter)
        .populate('user', 'username email')
        .populate({
          path: 'linkedWineDefinition',
          populate: ['country', 'region', 'grapes']
        })
        .populate('resolvedBy', 'username')
        .sort({ status: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit),
      WineRequest.countDocuments(filter)
    ]);

    res.json({
      count: requests.length,
      total,
      requests
    });
  } catch (error) {
    console.error('Get wine requests error:', error);
    res.status(500).json({ error: 'Failed to get wine requests' });
  }
});

// PUT /api/admin/wine-requests/:id/resolve - Resolve wine request
router.put('/:id/resolve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { wineDefinitionId, createNew, wineData, adminNotes, applyGrapes } = req.body;

    const wineRequest = await WineRequest.findById(req.params.id);
    if (!wineRequest) {
      return res.status(404).json({ error: 'Wine request not found' });
    }

    if (wineRequest.status !== 'pending') {
      return res.status(400).json({ error: 'Wine request has already been resolved' });
    }

    let linkedWine;

    // ── Grape suggestion: apply selected grapes to the linked wine ──
    if (wineRequest.requestType === 'grape_suggestion') {
      if (!wineRequest.linkedWineDefinition) {
        return res.status(400).json({ error: 'Grape suggestion has no linked wine definition' });
      }
      linkedWine = await WineDefinition.findById(wineRequest.linkedWineDefinition);
      if (!linkedWine) {
        return res.status(404).json({ error: 'Linked wine definition not found' });
      }
      if (Array.isArray(applyGrapes) && applyGrapes.length > 0) {
        const existing = new Set(linkedWine.grapes.map(g => g.toString()));
        for (const grapeId of applyGrapes) {
          if (!existing.has(grapeId.toString())) {
            linkedWine.grapes.push(grapeId);
          }
        }
        await linkedWine.save();
        searchService.indexWine(linkedWine._id);
      }
    } else if (createNew && wineData) {
      // Create new wine definition — through the same canonicalization + dedup
      // probe as every other write surface (this branch used to bypass all of
      // it and also skipped the appellation tier-strip; dup analysis
      // 2026-07-22 RC4). A likely duplicate returns 409 with candidates so the
      // admin links the request to the existing wine instead — or resubmits
      // with confirmCreate:true after an explicit "create anyway".
      const { name, producer, country, region, appellation, grapes, type, image } = wineData;

      if (!name || !producer || !country) {
        return res.status(400).json({ error: 'Name, producer, and country are required to create wine' });
      }
      if (typeof name !== 'string' || typeof producer !== 'string') {
        return res.status(400).json({ error: 'Name and producer must be strings' });
      }
      if (!isValidId(String(country))) {
        return res.status(400).json({ error: 'Invalid country' });
      }

      const cleanProducer = producer.trim();
      const cleanName = canonicalizeWineName(name, cleanProducer);
      const cleanAppellation = normalizeAppellation(typeof appellation === 'string' ? appellation.trim() : null) || null;

      if (!req.body.confirmCreate) {
        const countryDoc = await Country.findById(String(country)).select('name').lean().catch(() => null);
        const probe = await findOrCreateWine(
          {
            name: cleanName, producer: cleanProducer, country: countryDoc?.name || '',
            region: '', appellation: cleanAppellation || '', type, grapes: [],
          },
          req.user.id,
          { matchOnly: true }
        );
        const dupes = probe.wine ? [{ wine: probe.wine, score: 1 }] : (probe.candidates || []);
        if (dupes.length > 0) {
          return res.status(409).json({
            error: 'Very similar registry wine(s) already exist — link the request to one of them instead, or create anyway if genuinely different.',
            candidates: dupes.map(d => ({
              _id: d.wine._id,
              name: d.wine.name,
              producer: d.wine.producer,
              appellation: d.wine.appellation || null,
              score: d.score,
            })),
          });
        }
      }

      const normalizedKey = generateWineKey(cleanName, cleanProducer, cleanAppellation);

      linkedWine = new WineDefinition({
        name: cleanName,
        producer: cleanProducer,
        country,
        region: region || null,
        appellation: cleanAppellation,
        grapes: grapes || [],
        type: type || 'red',
        image: image || wineRequest.image || null,
        normalizedKey,
        createdBy: req.user.id,
        createdVia: 'ui'
      });

      try {
        await linkedWine.save();
      } catch (err) {
        if (err.code === 11000) {
          // Identical normalizedKey already exists (race or a probe edge) —
          // same wine by definition, so resolve the request by LINKING it.
          linkedWine = await WineDefinition.findOne({ normalizedKey });
          if (!linkedWine) throw err;
        } else {
          throw err;
        }
      }

      // Sync to search index (fire-and-forget)
      searchService.indexWine(linkedWine._id);
    } else if (wineDefinitionId) {
      // Link to existing wine
      linkedWine = await WineDefinition.findById(wineDefinitionId);
      if (!linkedWine) {
        return res.status(404).json({ error: 'Wine definition not found' });
      }
    } else {
      return res.status(400).json({ error: 'Must provide either wineDefinitionId or wineData to create new wine' });
    }

    // Update wine request
    wineRequest.status = 'resolved';
    wineRequest.resolvedBy = req.user.id;
    wineRequest.resolvedAt = new Date();
    wineRequest.linkedWineDefinition = linkedWine._id;
    wineRequest.adminNotes = adminNotes ? stripHtml(adminNotes) : '';

    await wineRequest.save();

    // Award Cellar Cred to the submitting user
    const credEvent = wineRequest.requestType === 'grape_suggestion' ? 'grape_suggestion_approved' : 'wine_request_approved';
    incrementCred(wineRequest.user, credEvent).catch(() => {});

    // Backfill any bottles that were imported while waiting for this wine
    let backfilledCount = 0;
    if (wineRequest.requestType === 'new_wine') {
      // Capture the distinct vintages BEFORE the update unsets pendingWineRequest
      // — needed to seed the maturity queue once the wine is known.
      const pendingVintages = await Bottle.distinct('vintage', { pendingWineRequest: wineRequest._id });

      const result = await Bottle.updateMany(
        { pendingWineRequest: wineRequest._id },
        { $set: { wineDefinition: linkedWine._id }, $unset: { pendingWineRequest: '' } }
      );
      backfilledCount = result.modifiedCount || 0;

      // Now that these bottles have a real wineDefinition, put each wine+vintage
      // into the sommelier maturity queue — mirroring the hand-add and matched-
      // import paths. Without this, wines that entered via an import "request"
      // never surfaced for a somm to set a drink window.
      for (const vintage of pendingVintages) {
        await ensurePendingVintageProfile(linkedWine._id, vintage);
      }
    }

    let notifMsg;
    if (wineRequest.requestType === 'grape_suggestion') {
      notifMsg = `Your grape suggestion for "${wineRequest.wineName}" has been reviewed. Thank you for helping improve the wine registry!`;
    } else if (backfilledCount > 0) {
      notifMsg = `Your request for "${wineRequest.wineName}" has been approved and added to the registry as "${linkedWine.name}" by ${linkedWine.producer}. Your ${backfilledCount} bottle${backfilledCount !== 1 ? 's' : ''} in the cellar have been updated.`;
    } else {
      notifMsg = `Your request for "${wineRequest.wineName}" has been approved. It was added to the registry as "${linkedWine.name}" by ${linkedWine.producer}.`;
    }

    createNotification(
      wineRequest.user,
      'wine_request_resolved',
      'Wine request approved',
      notifMsg,
      '/wine-requests'
    );

    await wineRequest.populate([
      { path: 'user', select: 'username email' },
      {
        path: 'linkedWineDefinition',
        populate: ['country', 'region', 'grapes']
      },
      { path: 'resolvedBy', select: 'username' }
    ]);

    logAudit(req, 'admin.request.resolve',
      { type: 'wineRequest', id: wineRequest._id },
      { wineName: wineRequest.wineName, linkedWineId: linkedWine._id }
    );

    res.json({ wineRequest });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        error: 'Wine already exists with this name, producer, and appellation combination'
      });
    }
    console.error('Resolve wine request error:', error);
    res.status(500).json({ error: 'Failed to resolve wine request' });
  }
});

// PUT /api/admin/wine-requests/:id/reject - Reject wine request
router.put('/:id/reject', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { adminNotes } = req.body;

    if (!adminNotes || !adminNotes.trim()) {
      return res.status(400).json({ error: 'Admin notes are required when rejecting a request' });
    }

    const wineRequest = await WineRequest.findById(req.params.id);
    if (!wineRequest) {
      return res.status(404).json({ error: 'Wine request not found' });
    }

    if (wineRequest.status !== 'pending') {
      return res.status(400).json({ error: 'Wine request has already been resolved' });
    }

    wineRequest.status = 'rejected';
    wineRequest.resolvedBy = req.user.id;
    wineRequest.resolvedAt = new Date();
    wineRequest.adminNotes = adminNotes.trim();

    await wineRequest.save();

    createNotification(
      wineRequest.user,
      'wine_request_rejected',
      'Wine request declined',
      `Your request for "${wineRequest.wineName}" was declined. Reason: ${adminNotes.trim()}`,
      '/wine-requests'
    );

    await wineRequest.populate([
      { path: 'user', select: 'username email' },
      { path: 'resolvedBy', select: 'username' }
    ]);

    logAudit(req, 'admin.request.reject',
      { type: 'wineRequest', id: wineRequest._id },
      { wineName: wineRequest.wineName }
    );

    res.json({ wineRequest });
  } catch (error) {
    console.error('Reject wine request error:', error);
    res.status(500).json({ error: 'Failed to reject wine request' });
  }
});

module.exports = router;
