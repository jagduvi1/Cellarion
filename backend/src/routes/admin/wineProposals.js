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
 *                        performWineMerge (services/wineMergeOps.js); non_wine via
 *                        the quarantine flag + pending maturity-queue cleanup.
 *                        Any apply failure reverts the claim — no half-approved
 *                        states. A producer change that would give the wine a
 *                        spelling the rest of its producer does not use needs
 *                        the admin's pick — body { producerSpelling: 'existing'
 *                        (+ existingSpelling) | 'renameAll' | 'proposed' } —
 *                        and answers 409 code 'producer_spelling_split' with
 *                        the registry's spellings until it has one.
 *   POST /:id/reject   — reason required (5–2000), stored on the row.
 *
 * The decisions themselves (approveProposal, rejectProposal) are in
 * services/wineProposalDecisionOps.js; the handlers here call them.
 *
 * Query-filter values are always literals from static arrays — never raw
 * request input (CodeQL query-injection rule, aiBudgetRequests pattern).
 */
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const Grape = require('../../models/Grape');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { reembedActiveVintages } = require('../../services/embeddingJob');
const { reenrichAfterRecordEdit } = require('../../services/enrichmentJob');
const { otherProducerSpellings, displaySpelling } = require('../../services/producerSpelling');
const { normalizeString, resolveGrapeName } = require('../../utils/normalize');
const { parsePagination } = require('../../utils/pagination');
const { isValidId } = require('../../utils/validation');
// What approving or rejecting one proposal does lives in the service. This
// file parses the requests, lists the queue with its live diff, and runs the
// bulk loops over the same two functions.
const {
  countryAfter, parseSpellingChoice, approveProposal, parseRejectReason, rejectProposal,
} = require('../../services/wineProposalDecisionOps');

router.use(requireAuth, requireRole('admin'));

// Keep in sync with the WineCorrectionProposal schema enums. 'decided' is a
// list-only alias for everything that is no longer pending — approved,
// rejected and closed (the review modal's second tab). 'closed' = the wine was
// merged away or deleted while the proposal waited; no reviewer decided it.
const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'closed'];
// `grapes` is deliberately NOT here: it is a LIST, and the diff/drift shape
// this list feeds is string-to-string. It is rendered by joining the names,
// alongside these, in the diff builder below.
const IDENTITY_FIELDS = ['producer', 'name', 'appellation', 'region', 'country', 'classification', 'type', 'colour'];

/** Grape names for display in a diff row — the same join both sides use. */
const grapeLabel = (names) => (Array.isArray(names) && names.length ? names.join(', ') : null);

// The live identity values a diff row compares against (region/country as names).
const liveIdentity = (wine) => ({
  producer: wine.producer || null,
  name: wine.name || null,
  appellation: wine.appellation || null,
  region: wine.region?.name || null,
  country: wine.country?.name || null,
  classification: wine.classification || null,
  type: wine.type || null,
  colour: wine.colour || null,
  // Populated when the caller asked for it; a bare id array joins to nothing
  // and the row simply reads "—", which is honest for an unpopulated read.
  grapes: grapeLabel((wine.grapes || []).map((g) => g && g.name).filter(Boolean)),
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
      filter.status = { $in: PROPOSAL_STATUSES.slice(1) };
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
        select: 'name producer appellation classification type colour nonWine country region grapes',
        populate: [
          { path: 'country', select: 'name' },
          { path: 'region', select: 'name' },
          // For the grapes diff row's CURRENT side.
          { path: 'grapes', select: 'name' },
        ],
      },
      { path: 'mergeTargetId', select: 'name producer appellation type' },
    ]);

    // A user may deliberately propose a variety the taxonomy lacks (the web
    // grape picker's "add as a new variety"); approving refuses it until the
    // variety exists. One batched lookup for the page, so the modal can say so
    // up front instead of the admin learning it from a 400.
    const proposedGrapeKeys = new Set();
    for (const p of rows) {
      for (const g of (p.proposedFields && p.proposedFields.grapes) || []) {
        const key = normalizeString(resolveGrapeName(g));
        if (key) proposedGrapeKeys.add(key);
      }
    }
    const knownGrapeKeys = new Set();
    if (proposedGrapeKeys.size) {
      const keys = [...proposedGrapeKeys];
      const found = await Grape.find({ $or: [{ normalizedName: { $in: keys } }, { normalizedSynonyms: { $in: keys } }] })
        .select('normalizedName normalizedSynonyms').lean();
      for (const g of found) {
        knownGrapeKeys.add(g.normalizedName);
        for (const s of g.normalizedSynonyms || []) knownGrapeKeys.add(s);
      }
    }
    const isUnknownGrape = (name) => {
      const key = normalizeString(resolveGrapeName(name));
      return !key || !knownGrapeKeys.has(key);
    };

    // A pending producer change that would leave the wine spelled unlike the
    // rest of its producer — said up front, like an unknown grape, so the
    // admin picks the spelling instead of learning it from a 409.
    const otherSpellingsById = new Map();
    await Promise.all(rows.map(async (p) => {
      const pf = p.proposedFields || {};
      const wine = p.wineDefinition;
      if (p.status !== 'pending' || p.kind !== 'field_correction' || !pf.producer || !wine) return;
      if (displaySpelling(pf.producer) === displaySpelling(wine.producer)) return;
      const others = await otherProducerSpellings(pf.producer, await countryAfter(pf, wine), { excludeWineId: wine._id });
      if (others.length) otherSpellingsById.set(String(p._id), others);
    }));

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
        // Grapes render like every other row — joined names on both sides —
        // so the modal needs no list-aware branch.
        if (Array.isArray(p.proposedFields.grapes) && p.proposedFields.grapes.length) {
          diff.grapes = { current: live ? live.grapes : null, proposed: grapeLabel(p.proposedFields.grapes) };
          // Only worth saying while it can still be acted on.
          const unknown = p.status === 'pending' ? p.proposedFields.grapes.filter(isUnknownGrape) : [];
          if (unknown.length) diff.grapes.unknown = unknown;
        }
        if (diff.producer && otherSpellingsById.has(String(p._id))) {
          diff.producer.otherSpellings = otherSpellingsById.get(String(p._id));
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
        // Later filings by the same proposer, each with its own reason and
        // evidence — the original reason/evidence above back the original
        // fields only.
        amendments: (p.amendments || []).map((a) => ({
          at: a.at, fields: a.fields || [], reason: a.reason, evidenceUrl: a.evidenceUrl || null,
        })),
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

// POST /api/admin/wine-proposals/:id/approve — claim, then apply by kind
router.post('/:id/approve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const parsed = parseSpellingChoice(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { status, body } = await approveProposal(new mongoose.Types.ObjectId(req.params.id), req, { producerSpelling: parsed.choice });
    res.status(status).json(body);
  } catch (err) {
    console.error('Approve wine proposal error:', err);
    res.status(500).json({ error: 'Failed to approve proposal' });
  }
});

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

// ── Bulk decisions (the middle road) ────────────────────────────────────────
// The somm files evidence-backed proposals one at a time; clearing a batch
// through per-row round trips is the queue's whole overhead. The review gate
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
    // wineId -> { wine, changed } — the LAST applied doc wins (it carries all
    // earlier corrections of the batch), changed ORs across proposals.
    const followThroughs = new Map();
    for (const id of parsed.ids) {
      try {
        const { status, body, followThrough } = await approveProposal(new mongoose.Types.ObjectId(id), req, { deferFollowThrough: true });
        if (followThrough) {
          const prev = followThroughs.get(followThrough.wineId);
          followThroughs.set(followThrough.wineId, {
            wine: followThrough.wine,
            changed: (prev?.changed || false) || followThrough.changed,
          });
        }
        // A spelling split needs the admin's pick, which a batch cannot carry:
        // the row stays pending and its result carries the spellings, so the
        // modal can offer the choice on that row.
        results.push(status === 200
          ? { proposalId: id, ok: true, status, appliedNote: body.appliedNote }
          : {
            proposalId: id, ok: false, status, error: body.error,
            ...(body.code ? { code: body.code } : {}),
            ...(body.spellings ? { proposed: body.proposed, spellings: body.spellings } : {}),
          });
      } catch (err) {
        console.error('Bulk approve item error:', id, err);
        results.push({ proposalId: id, ok: false, status: 500, error: 'Failed to approve proposal' });
      }
    }
    // ONE follow-through per wine, after every decision in the batch has
    // applied. Per-proposal firing let an early proposal's re-enrich race the
    // later applies on the same wine — the last writer was indeterminate and
    // a profile could describe an intermediate identity — and spent one
    // forced AI call per PROPOSAL instead of per wine (audit 2026-08-16).
    // A wine absorbed by a merge later in the batch fails the re-enrich's
    // findById silently, which is the correct outcome.
    for (const { wine, changed } of followThroughs.values()) {
      reembedActiveVintages(wine._id).catch(() => {});
      reenrichAfterRecordEdit(wine, changed);
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
// Exported for the MCP self-apply path (services/proposalDirectApply decides
// WHICH proposals may take it). Deliberately the same function the admin route
// calls rather than a second write path: canonicalization, the dedup-key regen,
// the search/embedding/IndexNow follow-through and the re-enrich all live in
// it (services/wineProposalDecisionOps), and a parallel implementation would
// drift from them silently — which is exactly how "Yecla DO" once reached a
// wine unresolved.
module.exports.approveProposal = approveProposal;
