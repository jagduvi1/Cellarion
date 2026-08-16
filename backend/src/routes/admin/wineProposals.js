/**
 * /api/admin/wine-proposals — admin review of sommelier correction proposals
 * (models/WineCorrectionProposal.js; filed over MCP by propose_wine_correction).
 *
 *   GET  /             — list, pending-first, paginated; ?status=pending|
 *                        approved|rejected|decided. Each row carries a per-field
 *                        {current, proposed} diff computed from the LIVE wine,
 *                        plus the propose-time snapshot so drift is visible.
 *                        Envelope: { proposals, total, page, pages, pendingCount }
 *                        (pendingCount feeds the AdminWines toolbar badge).
 *   POST /:id/approve  — atomically claim the pending row, then APPLY by kind:
 *                        field_correction with the same semantics as the admin
 *                        wine PUT (trim, normalizeAppellation, resolve-only
 *                        country, gated region mint, normalizedKey regen,
 *                        E11000 → 409 "merge instead"); merge via the extracted
 *                        performWineMerge (routes/admin/wines.js); non_wine via
 *                        the quarantine flag + pending maturity-queue cleanup.
 *                        Any apply failure reverts the claim — no half-approved
 *                        states.
 *   POST /:id/reject   — reason required (5–500), stored on the row.
 *
 * Query-filter values are always literals from static arrays — never raw
 * request input (CodeQL query-injection rule, aiBudgetRequests pattern).
 */
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const WineDefinition = require('../../models/WineDefinition');
const WineVintageProfile = require('../../models/WineVintageProfile');
const Bottle = require('../../models/Bottle');
const Country = require('../../models/Country');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../services/audit');
const { submitUrls } = require('../../services/indexNow');
const searchService = require('../../services/search');
const { reembedActiveVintages } = require('../../services/embeddingJob');
const { profileInputsSnapshot, reenrichAfterRecordEdit } = require('../../services/enrichmentJob');
const { findOrCreateRegion } = require('../../services/findOrCreateWine');
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const { performWineMerge } = require('./wines');
const { generateWineKey, normalizeAppellation, normalizeString, resolveCountryName } = require('../../utils/normalize');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');

router.use(requireAuth, requireRole('admin'));

// Keep in sync with the WineCorrectionProposal schema enums. 'decided' is a
// list-only alias for approved+rejected (the review modal's second tab).
const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'];
const IDENTITY_FIELDS = ['producer', 'name', 'appellation', 'region', 'country', 'classification'];

const REJECT_REASON_MIN = 5;
const REJECT_REASON_MAX = 500;

// The live identity values a diff row compares against (region/country as names).
const liveIdentity = (wine) => ({
  producer: wine.producer || null,
  name: wine.name || null,
  appellation: wine.appellation || null,
  region: wine.region?.name || null,
  country: wine.country?.name || null,
  classification: wine.classification || null,
});

// GET /api/admin/wine-proposals — list, pending first, newest first within status
router.get('/', async (req, res) => {
  try {
    const { limit, offset, page } = parsePagination(req.query, { limit: 20, maxLimit: 200 });

    // Filter values come from static arrays, never from the request.
    const statusIdx = PROPOSAL_STATUSES.indexOf(String(req.query.status || ''));
    const filter = {};
    if (statusIdx !== -1) {
      filter.status = PROPOSAL_STATUSES[statusIdx];
    } else if (String(req.query.status || '') === 'decided') {
      filter.status = { $in: [PROPOSAL_STATUSES[1], PROPOSAL_STATUSES[2]] };
    }

    // Pending-first needs a derived sort key: the status enum does not sort
    // alphabetically ('approved' < 'pending'), so a plain .sort() cannot put
    // pending on top of the unfiltered view.
    const [rows, total, pendingCount] = await Promise.all([
      WineCorrectionProposal.aggregate([
        { $match: filter },
        { $addFields: { _pendingFirst: { $cond: [{ $eq: ['$status', 'pending'] }, 0, 1] } } },
        { $sort: { _pendingFirst: 1, createdAt: -1 } },
        { $skip: offset },
        { $limit: limit },
        { $project: { _pendingFirst: 0 } },
      ]),
      WineCorrectionProposal.countDocuments(filter),
      WineCorrectionProposal.countDocuments({ status: 'pending' }),
    ]);

    await WineCorrectionProposal.populate(rows, [
      { path: 'proposer', select: 'username' },
      {
        path: 'wineDefinition',
        select: 'name producer appellation classification type nonWine country region',
        populate: [{ path: 'country', select: 'name' }, { path: 'region', select: 'name' }],
      },
      { path: 'mergeTargetId', select: 'name producer appellation type' },
    ]);

    const proposals = rows.map((p) => {
      const live = p.wineDefinition ? liveIdentity(p.wineDefinition) : null;
      // Per-field diff against the LIVE wine — the snapshot rides along so the
      // client can flag fields that drifted since the proposal was filed.
      let diff = null;
      if (p.kind === 'field_correction' && p.proposedFields) {
        diff = {};
        for (const f of IDENTITY_FIELDS) {
          const proposed = p.proposedFields[f];
          if (proposed === undefined || proposed === null || proposed === '') continue;
          diff[f] = { current: live ? live[f] : null, proposed };
        }
      }
      return {
        _id: p._id,
        kind: p.kind,
        status: p.status,
        proposer: p.proposer ? { _id: p.proposer._id, username: p.proposer.username } : null,
        wineDefinition: p.wineDefinition
          ? { _id: p.wineDefinition._id, ...live, type: p.wineDefinition.type || null, nonWine: !!p.wineDefinition.nonWine }
          : null,
        mergeTarget: p.mergeTargetId
          ? { _id: p.mergeTargetId._id, name: p.mergeTargetId.name, producer: p.mergeTargetId.producer || null, appellation: p.mergeTargetId.appellation || null, type: p.mergeTargetId.type || null }
          : null,
        diff,
        currentSnapshot: p.currentSnapshot || null,
        evidenceUrl: p.evidenceUrl || null,
        reason: p.reason,
        rejectReason: p.rejectReason || null,
        appliedNote: p.appliedNote || null,
        decidedAt: p.decidedAt || null,
        createdAt: p.createdAt,
      };
    });

    res.json({ proposals, total, page, pages: Math.ceil(total / limit), pendingCount });
  } catch (err) {
    console.error('Admin list wine proposals error:', err);
    res.status(500).json({ error: 'Failed to list wine proposals' });
  }
});

// Already-decided vs never-existed, after a failed claim (aiBudgetRequests pattern).
async function decideOutcome(proposalId) {
  const exists = await WineCorrectionProposal.exists({ _id: proposalId });
  return exists
    ? { status: 409, body: { error: 'Proposal has already been decided' } }
    : { status: 404, body: { error: 'Proposal not found' } };
}

// POST /api/admin/wine-proposals/:id/approve — claim, then apply by kind
router.post('/:id/approve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { status, body } = await approveProposal(new mongoose.Types.ObjectId(req.params.id), req);
    res.status(status).json(body);
  } catch (err) {
    console.error('Approve wine proposal error:', err);
    res.status(500).json({ error: 'Failed to approve proposal' });
  }
});

/**
 * Approve ONE proposal: atomic claim → apply by kind → per-proposal audit.
 * Returns { status, body } instead of writing to a response, so the single
 * route and the bulk loop run EXACTLY the same machinery — the
 * performWineMerge extraction pattern, one layer up. Unexpected errors are
 * thrown (after the claim revert) for the caller to map to its own 500.
 */
async function approveProposal(proposalId, req) {
    // Atomically CLAIM the pending row so only the first of two concurrent
    // decisions wins (the aiBudgetRequests check-then-act fix): a null result
    // means already-decided (409) or never-existed (404).
    const now = new Date();
    const proposal = await WineCorrectionProposal.findOneAndUpdate(
      { _id: proposalId, status: 'pending' },
      { $set: { status: 'approved', decidedBy: req.user.id, decidedAt: now } },
      { new: true }
    );
    if (!proposal) return decideOutcome(proposalId);

    // Any apply failure below reverts the claim so there is no half-approved
    // state. Best-effort by necessity: the moment our claim left 'pending',
    // the one-pending-per-(wine, kind) index frees — a proposal re-filed in
    // that window makes the revert collide, in which case we log and leave
    // the row decided rather than 500-ing over bookkeeping.
    const revertClaim = async () => {
      try {
        await WineCorrectionProposal.updateOne(
          { _id: proposal._id, status: 'approved', decidedAt: now },
          { $set: { status: 'pending', decidedBy: null, decidedAt: null } }
        );
      } catch (err) {
        console.error('Wine proposal claim revert failed:', err.message);
      }
    };

    let appliedNote = '';
    try {
      if (proposal.kind === 'field_correction') {
        const wine = await WineDefinition.findById(proposal.wineDefinition);
        if (!wine) {
          await revertClaim();
          return { status: 404, body: { error: 'The proposed wine no longer exists' } };
        }
        // Before-image for the re-enrich decision below — same real-change
        // semantics as the admin PUT.
        const beforeProfileInputs = profileInputsSnapshot(wine);
        const pf = proposal.proposedFields || {};
        const applied = [];

        // Same identity-field semantics as the admin wine PUT: trimmed
        // strings, appellation normalized, country RESOLVED (never minted),
        // region through the gated findOrCreateRegion helper.
        if (pf.name) { wine.name = pf.name.trim(); applied.push('name'); }
        if (pf.producer) { wine.producer = pf.producer.trim(); applied.push('producer'); }
        if (pf.classification) { wine.classification = pf.classification.trim(); applied.push('classification'); }
        if (pf.appellation) {
          // Tier-strip AND curated-registry resolve. Approving a proposal is a
          // registry WRITE, so it owes the same canonicalization as the mint
          // chokepoint: without the resolver a somm's "Yecla DO" landed
          // verbatim on the wine (prod, 2026-08-12) because the trailing "DO"
          // is deliberately outside normalizeAppellation's token set.
          wine.appellation = await resolveCanonicalAppellation(normalizeAppellation(pf.appellation.trim()));
          applied.push('appellation');
        }

        let countryDoc = null;
        if (pf.country) {
          // Alias → canonical name → existing Country doc. Unresolvable is a
          // 400, never a minted Country — taxonomy grows deliberately, not
          // through an approval click.
          countryDoc = await Country.findOne({ normalizedName: normalizeString(resolveCountryName(pf.country)) });
          if (!countryDoc) {
            await revertClaim();
            return { status: 400, body: { error: `Unknown country "${pf.country}" — add it in Admin → Taxonomy first, then approve` } };
          }
          wine.country = countryDoc._id;
          applied.push('country');
        }
        if (pf.region) {
          // findOrCreateRegion carries the mint gates (comma hierarchies and
          // country-name regions → null, new mints flagged pendingReview).
          // A gated null is the helper's honest "no region" and is applied as
          // such rather than failing the whole approve.
          const regionDoc = await findOrCreateRegion(pf.region, countryDoc?._id || wine.country, req.user.id);
          wine.region = regionDoc?._id || null;
          applied.push(regionDoc ? 'region' : 'region (cleared — name failed the mint gates)');
        }

        // Same rule as the PUT: the dedup key follows name/producer/appellation.
        if (pf.name || pf.producer || pf.appellation) {
          wine.normalizedKey = generateWineKey(wine.name, wine.producer, wine.appellation);
        }

        try {
          await wine.save();
        } catch (err) {
          if (err.code === 11000) {
            await revertClaim();
            return { status: 409, body: {
              error: 'Applying this correction would make the wine identical to an existing registry wine — use a merge proposal instead',
            } };
          }
          throw err;
        }

        // The PUT's follow-through: registry index, the bottles' denormalized
        // search docs (no scheduled resync exists), the embedding text — and
        // the IndexNow ping (an approved identity fix changes the public wine
        // page exactly like a PUT rename; parity per audit 2026-08-10).
        submitUrls(`/wines/${wine._id}`);
        searchService.indexWine(wine._id);
        Bottle.distinct('_id', { wineDefinition: wine._id })
          .then((ids) => searchService.bulkIndexBottles(ids))
          .catch((err) => console.error('Bottle re-index after proposal apply failed:', err.message));
        reembedActiveVintages(wine._id).catch(() => {});
        // And the PUT's re-enrich (parity gap found live 2026-08-16: approving
        // "Fabelhaft" → "Niepoort" left the négociant-fiction profile attached
        // until a manual force re-enrich). Real-change only, curator-safe —
        // see reenrichAfterRecordEdit.
        reenrichAfterRecordEdit(wine, profileInputsSnapshot(wine) !== beforeProfileInputs);

        appliedNote = `Applied: ${applied.join(', ')}`;
      } else if (proposal.kind === 'merge') {
        // The extracted single-pair merge — exactly what POST /:id/merge runs.
        const result = await performWineMerge(String(proposal.wineDefinition), String(proposal.mergeTargetId), req);
        if (result.error) {
          await revertClaim();
          return { status: result.error.status, body: { error: result.error.message } };
        }
        const targetLabel = [result.target.producer, result.target.name].filter(Boolean).join(' — ');
        appliedNote = `Merged into ${targetLabel} (${result.bottlesMoved} bottle(s) moved)`;
      } else { // non_wine
        const wine = await WineDefinition.findById(proposal.wineDefinition);
        if (!wine) {
          await revertClaim();
          return { status: 404, body: { error: 'The proposed wine no longer exists' } };
        }
        // Same semantics as POST /:id/non-wine value:true — flag + let the
        // self-healing index sync drop it from search.
        wine.nonWine = true;
        await wine.save();
        searchService.indexWine(wine._id);
        // Completes the quarantine for the somm queue: PENDING maturity rows
        // go (they are auto-seeded stubs); REVIEWED windows are curated data
        // and stay with the record.
        const del = await WineVintageProfile.deleteMany({ wineDefinition: wine._id, status: 'pending' });
        appliedNote = `Quarantined as non-wine; ${del.deletedCount || 0} pending maturity-queue row(s) removed`;
        logAudit(req, 'admin.wine.nonWine', { type: 'wine', id: wine._id },
          { value: true, name: wine.name, producer: wine.producer, via: 'wine-proposal' });
      }
    } catch (err) {
      // Unexpected apply failure: give the row back to the queue (merges are
      // idempotent + re-runnable by design, field writes did not commit).
      await revertClaim();
      throw err;
    }

    await WineCorrectionProposal.updateOne({ _id: proposal._id }, { $set: { appliedNote } });

    logAudit(req, 'admin.wineProposal.approve',
      { type: 'WineCorrectionProposal', id: proposal._id },
      {
        kind: proposal.kind,
        wineDefinitionId: proposal.wineDefinition,
        ...(proposal.mergeTargetId ? { mergeTargetId: proposal.mergeTargetId } : {}),
        appliedNote,
      });

    return { status: 200, body: { message: 'Proposal approved and applied', proposalId: proposal._id, status: 'approved', appliedNote } };
}

// Reason hygiene shared by the single and bulk reject paths: plain text only,
// bounded even after strip (reject_price_request hygiene).
function parseRejectReason(raw) {
  const reason = stripHtml(typeof raw === 'string' ? raw : '');
  if (!reason || reason.length < REJECT_REASON_MIN) {
    return { error: `A reject reason of at least ${REJECT_REASON_MIN} characters is required` };
  }
  if (reason.length > REJECT_REASON_MAX) {
    return { error: `Reject reason must be at most ${REJECT_REASON_MAX} characters` };
  }
  return { reason };
}

// POST /api/admin/wine-proposals/:id/reject — reason required, stored on the row
router.post('/:id/reject', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const parsed = parseRejectReason(req.body?.reason);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { status, body } = await rejectProposal(new mongoose.Types.ObjectId(req.params.id), parsed.reason, req);
    res.status(status).json(body);
  } catch (err) {
    console.error('Reject wine proposal error:', err);
    res.status(500).json({ error: 'Failed to reject proposal' });
  }
});

/** Reject ONE proposal via the same atomic claim. Returns { status, body }. */
async function rejectProposal(proposalId, reason, req) {
  const proposal = await WineCorrectionProposal.findOneAndUpdate(
    { _id: proposalId, status: 'pending' },
    { $set: { status: 'rejected', decidedBy: req.user.id, decidedAt: new Date(), rejectReason: reason } },
    { new: true }
  );
  if (!proposal) return decideOutcome(proposalId);

  logAudit(req, 'admin.wineProposal.reject',
    { type: 'WineCorrectionProposal', id: proposal._id },
    { kind: proposal.kind, wineDefinitionId: proposal.wineDefinition, reason });

  return { status: 200, body: { message: 'Proposal rejected', proposalId: proposal._id, status: 'rejected' } };
}

// ── Bulk decisions (ticket 6a8162c5, ask #3 — the middle road) ──────────────
// The somm files evidence-backed proposals one at a time; clearing a batch
// through per-row round trips was the queue's whole overhead. The review gate
// STAYS — an admin still reads every row — the clicking goes. Each id runs
// the EXACT single-decision machinery above, sequentially (registry applies
// re-key, reindex and re-enrich; concurrency buys nothing and could
// interleave writes on sibling wines), and reports a per-row outcome: one
// row's 409 "merge instead" never blocks the rest of the batch. Per-proposal
// audit entries come from the shared functions, so the audit stream reads the
// same whether a decision arrived alone or in a batch.
const MAX_BULK_DECISIONS = 50;

function parseBulkIds(body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'ids must be a non-empty array' };
  if (ids.length > MAX_BULK_DECISIONS) return { error: `At most ${MAX_BULK_DECISIONS} proposals per call` };
  if (ids.some((id) => !isValidId(id))) return { error: 'Every id must be a valid proposal id' };
  return { ids: [...new Set(ids.map(String))] };
}

router.post('/bulk-approve', async (req, res) => {
  try {
    const parsed = parseBulkIds(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const results = [];
    for (const id of parsed.ids) {
      try {
        const { status, body } = await approveProposal(new mongoose.Types.ObjectId(id), req);
        results.push(status === 200
          ? { proposalId: id, ok: true, status, appliedNote: body.appliedNote }
          : { proposalId: id, ok: false, status, error: body.error });
      } catch (err) {
        console.error('Bulk approve item error:', id, err);
        results.push({ proposalId: id, ok: false, status: 500, error: 'Failed to approve proposal' });
      }
    }
    const approved = results.filter((r) => r.ok).length;
    res.json({ results, approved, failed: results.length - approved });
  } catch (err) {
    console.error('Bulk approve wine proposals error:', err);
    res.status(500).json({ error: 'Failed to bulk-approve proposals' });
  }
});

router.post('/bulk-reject', async (req, res) => {
  try {
    const parsed = parseBulkIds(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    // ONE shared reason for the batch, validated once — nothing is decided on
    // a bad reason.
    const reasonParsed = parseRejectReason(req.body?.reason);
    if (reasonParsed.error) return res.status(400).json({ error: reasonParsed.error });
    const results = [];
    for (const id of parsed.ids) {
      try {
        const { status, body } = await rejectProposal(new mongoose.Types.ObjectId(id), reasonParsed.reason, req);
        results.push(status === 200
          ? { proposalId: id, ok: true, status }
          : { proposalId: id, ok: false, status, error: body.error });
      } catch (err) {
        console.error('Bulk reject item error:', id, err);
        results.push({ proposalId: id, ok: false, status: 500, error: 'Failed to reject proposal' });
      }
    }
    const rejected = results.filter((r) => r.ok).length;
    res.json({ results, rejected, failed: results.length - rejected });
  } catch (err) {
    console.error('Bulk reject wine proposals error:', err);
    res.status(500).json({ error: 'Failed to bulk-reject proposals' });
  }
});

module.exports = router;
