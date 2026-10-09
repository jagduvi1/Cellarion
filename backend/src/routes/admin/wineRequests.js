const { splitPradikatFromAppellation } = require('../../utils/styleTerms');
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const WineRequest = require('../../models/WineRequest');
const WineDefinition = require('../../models/WineDefinition');
const { generateWineKey, normalizeAppellation, normalizeString } = require('../../utils/normalize');
const { canonicalizeWineName } = require('../../utils/producerPrefix');
const Country = require('../../models/Country');
const { findOrCreateWine } = require('../../services/findOrCreateWine');
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { completeRequestResolve, completeRequestReject } = require('../../services/wineRequestOps');
const { incrementCred } = require('../../utils/cellarCred');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');
const { validateImageRef } = require('../../services/accountOps');
const { WINE_COLOURS, colourTypeConflict } = require('../../utils/wineColour');

const router = express.Router();

// All routes require admin role
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/wine-requests - List all wine requests
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const { limit, offset: skip } = parsePagination(req.query, { limit: 50, maxLimit: 200 });
    const filter = {};
    const VALID_STATUSES = ['pending', 'resolved', 'rejected', 'withdrawn'];

    if (status) {
      if (!VALID_STATUSES.includes(String(status))) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      filter.status = String(status);
    } else {
      // Withdrawn requests left the queue with their (soft-deleted) cellar —
      // not judged, and nothing for a curator to do. They only show when
      // asked for explicitly (?status=withdrawn), never in the default list
      // an admin works through.
      filter.status = { $ne: 'withdrawn' };
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
      const { name, producer, country, region, appellation, grapes, type, colour, image, useRequestPhoto, addBackPhoto } = wineData;

      if (!name || !producer || !country) {
        return res.status(400).json({ error: 'Name, producer, and country are required to create wine' });
      }
      if (typeof name !== 'string' || typeof producer !== 'string') {
        return res.status(400).json({ error: 'Name and producer must be strings' });
      }
      if (!isValidId(String(country))) {
        return res.status(400).json({ error: 'Invalid country' });
      }
      {
        // Same rule as the admin wine editor: refuse a colour the type cannot
        // carry rather than approve the request and silently drop it.
        const colourErr = colourTypeConflict(type || null, WINE_COLOURS.includes(colour) ? colour : null);
        if (colourErr) return res.status(400).json({ error: colourErr });
      }

      // Image: an explicitly blank field means "no image" — it must NOT fall
      // back to the requester's value (audit 2026-09 F06-1). Whatever is
      // stored has to pass the http(s) / own-upload check, so a
      // protocol-relative or javascript: reference can never reach
      // WineDefinition.image through an approval.
      //
      // A photo the requester attached is stored inline on the request. It is
      // never copied into the wine record (half a megabyte of text in every
      // list that shows the wine): it becomes the new wine's official picture
      // as a file, once the wine exists — when the admin keeps it
      // (useRequestPhoto), or when an API caller leaves the image out.
      const { decodeInlineImage, attachOfficialWineImage, ingestBottleImage } = require('../../services/imageOps');
      const { sanitizeImageBuffer, hasTransparency } = require('../../services/imageSanitizer');
      const requestPhoto = decodeInlineImage(wineRequest.image);
      const blankImage = image === '' || image === null;
      const imageToStore = blankImage ? null : (image ?? (requestPhoto ? null : (wineRequest.image ?? null)));
      const imageErr = validateImageRef(imageToStore, { allowInline: false });
      if (imageErr) {
        return res.status(400).json({ error: `Wine image: ${imageErr}` });
      }
      const usePhoto = !!requestPhoto && !imageToStore
        && (useRequestPhoto === true || (useRequestPhoto === undefined && image === undefined));
      if (usePhoto) {
        // Refuse before anything is created, not after.
        try {
          await sanitizeImageBuffer(requestPhoto);
        } catch {
          return res.status(400).json({ error: 'The photo on the request could not be read. Approve without it, or give a picture link.' });
        }
      }
      // The back label (#1460) can join the new wine's PUBLIC photos — a
      // gallery photo marked as the back, never the wine's picture. On unless
      // the admin unticks it (addBackPhoto: false), like the front photo; an
      // inline photo only — a link is left on the request, nothing is fetched.
      const backPhoto = decodeInlineImage(wineRequest.backImage);
      const addBack = !!backPhoto && addBackPhoto !== false;
      if (addBack) {
        try {
          await sanitizeImageBuffer(backPhoto);
        } catch {
          return res.status(400).json({ error: 'The back label photo on the request could not be read. Untick "add the back label" to approve without it.' });
        }
      }

      const cleanProducer = producer.trim();
      const cleanName = canonicalizeWineName(name, cleanProducer);
      // Tier-strip AND curated-registry resolve — this branch bulk-builds the
      // WineDefinition itself rather than going through findOrCreateWine, so
      // the resolver has to be called explicitly or an approved request mints
      // a spelling variant of an already-curated appellation.
      // A bare Prädikat is not a place — same rule as findOrCreateWine (audit 2026-09-07).
      const pradikatSplit = splitPradikatFromAppellation(appellation, req.body.classification, cleanName);
      const cleanAppellation = await resolveCanonicalAppellation(
        normalizeAppellation(pradikatSplit.appellation)
      ) || null;

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

      // Same producer gate as the mint chokepoint and the admin POST
      // (release-audit MED-3): approval builds the row directly and must not
      // be the one surface that still publishes a place as a producer.
      {
        const { detectBlockingProducerIssue } = require('../../services/crossFieldScan');
        const blocked = await detectBlockingProducerIssue({ name: cleanName, producer: cleanProducer, appellation: cleanAppellation || '' });
        if (blocked) {
          return res.status(400).json({
            error: `"${cleanProducer}" is not a usable producer name — cross-field rule ${blocked.check} matched "${blocked.detail}", which belongs in a different field`,
          });
        }
      }

      // Adopt the registry's existing spelling for this producer, mirroring
      // the mint chokepoint (same-string majority + same-country decoration
      // variants). Approval builds the row directly, so without this the
      // approve button was one of the surfaces that could still mint a
      // display split. Fail-open — ambiguity stores the typed spelling.
      const { resolveCanonicalProducerSpelling } = require('../../services/producerSpelling');
      const producerToStore = await resolveCanonicalProducerSpelling(
        cleanProducer, normalizeString(cleanProducer), { countryId: String(country) }
      );

      const normalizedKey = generateWineKey(cleanName, producerToStore, cleanAppellation);

      linkedWine = new WineDefinition({
        name: cleanName,
        producer: producerToStore,
        country,
        region: region || null,
        appellation: cleanAppellation,
        classification: pradikatSplit.classification || undefined,
        grapes: grapes || [],
        type: type || null, // no guessed red (ticket 6a85ad44)
        // Sparkling/dessert/fortified only; the model hook drops anything else
        // and infers rosé from the name when this is empty.
        colour: WINE_COLOURS.includes(colour) ? colour : null,
        image: imageToStore,
        normalizedKey,
        createdBy: req.user.id,
        createdVia: 'ui',
        // WHOSE data this is, as opposed to who performed the write.
        // createdBy is the approving admin; a rights-holder complaint about
        // this record needs the person who asked for it, the surface they
        // used and, over the bridge, the install it came from.
        contribution: {
          user: wineRequest.user,
          via: wineRequest.via || 'ui',
          request: wineRequest._id,
          bridgeKey: wineRequest.bridgeKey || null,
          instanceHost: wineRequest.instanceHost || null,
          at: wineRequest.createdAt || new Date(),
        },
      });

      let createdHere = false;
      try {
        await linkedWine.save();
        createdHere = true;
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

      // The requester's photo becomes the new wine's official picture, stored
      // as a file like any admin upload (approved, public). Only for a wine
      // created here: a wine that already existed keeps its own picture. A
      // cut-out (transparent pixels: the request form sends its background-
      // removal preview) is kept as it is; an opaque photo goes through
      // background removal. Best-effort — the approval stands without it, and
      // a picture can be added later.
      if (usePhoto && createdHere) {
        try {
          const keepBackground = await hasTransparency(requestPhoto);
          const attached = await attachOfficialWineImage(
            { buffer: requestPhoto, wineDefinitionId: linkedWine._id, userId: req.user.id, userRoles: req.user.roles, keepBackground },
            req
          );
          if (attached.error) {
            console.error('[wine-requests] request photo not attached:', attached.error.message);
          } else {
            logAudit(req, 'admin.wine.image.set',
              { type: 'wine', id: linkedWine._id },
              { imageId: String(attached.image._id), fromRequest: String(wineRequest._id) });
          }
        } catch (err) {
          console.error('[wine-requests] request photo not attached:', err.message);
        }
      }

      // The back label joins the gallery: ingested like a member's upload and
      // published at birth (the admin approved it by leaving the box ticked),
      // marked as the back so a reader can tell the faces apart. Born approved
      // — approving it after the hand-off raced the background-removal worker,
      // which then settled it 'processed' and out of every gallery (release
      // audit 2026-10-09, H1). Not the official picture: assignedToWine stays
      // false. Only for a wine created here, and best-effort, like the front.
      if (addBack && createdHere) {
        try {
          const keepBackground = await hasTransparency(backPhoto);
          const ingest = await ingestBottleImage(
            { buffer: backPhoto, wineDefinitionId: linkedWine._id, userId: req.user.id, userRoles: req.user.roles, keepBackground, publish: { side: 'back' } },
            req
          );
          if (ingest.error) {
            console.error('[wine-requests] back label not added:', ingest.error.message);
          } else {
            logAudit(req, 'admin.image.approve',
              { type: 'image', id: ingest.image._id },
              { wineDefinitionId: String(linkedWine._id), visibility: 'public', fromRequest: String(wineRequest._id), side: 'back' });
          }
        } catch (err) {
          console.error('[wine-requests] back label not added:', err.message);
        }
      }
    } else if (wineDefinitionId) {
      // Link to existing wine
      linkedWine = await WineDefinition.findById(wineDefinitionId);
      if (!linkedWine) {
        return res.status(404).json({ error: 'Wine definition not found' });
      }
    } else {
      return res.status(400).json({ error: 'Must provide either wineDefinitionId or wineData to create new wine' });
    }

    // Mark resolved, move the bottles that waited on it, queue their vintages
    // and notify the requester — shared with the Registry Bridge request sync
    // (services/wineRequestOps), so both finish a request the same way.
    // Null: decided meanwhile (another admin, or the bridge sync) — nothing written.
    const resolved = await completeRequestResolve(wineRequest, linkedWine, { resolvedBy: req.user.id, adminNotes });
    if (!resolved) {
      return res.status(400).json({ error: 'Wine request has already been resolved' });
    }

    // Award Cellar Cred to the submitting user
    const credEvent = wineRequest.requestType === 'grape_suggestion' ? 'grape_suggestion_approved' : 'wine_request_approved';
    incrementCred(wineRequest.user, credEvent).catch(() => {});

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

    // Detach the waiting bottles BEFORE the status flip, mark rejected with the
    // reason and notify the requester — shared with the Registry Bridge
    // request sync (services/wineRequestOps). Null: decided meanwhile.
    const rejected = await completeRequestReject(wineRequest, { resolvedBy: req.user.id, adminNotes });
    if (!rejected) {
      return res.status(400).json({ error: 'Wine request has already been resolved' });
    }
    const { bottlesDetached } = rejected;

    await wineRequest.populate([
      { path: 'user', select: 'username email' },
      { path: 'resolvedBy', select: 'username' }
    ]);

    logAudit(req, 'admin.request.reject',
      { type: 'wineRequest', id: wineRequest._id },
      { wineName: wineRequest.wineName, bottlesDetached }
    );

    // bottlesDetached is additive — existing clients read only wineRequest.
    res.json({ wineRequest, bottlesDetached });
  } catch (error) {
    console.error('Reject wine request error:', error);
    res.status(500).json({ error: 'Failed to reject wine request' });
  }
});

module.exports = router;
