// Sommelier tools: profile reads — the weekly spot-check sample, the core
// wines nobody has verified, the pending corrections, and recording a
// spot-check outcome. (list_profile_audits, the trend read, sits in
// heldProfiles.js because of where it stands in the tool order.)
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const WineDefinition = require('../../../models/WineDefinition');
const Bottle = require('../../../models/Bottle');
const WineCorrectionProposal = require('../../../models/WineCorrectionProposal');
const { registerTool } = require('../../registry');
const { ok, fail, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAudit } = require('../../../services/audit');
const { isValidId } = require('../../../utils/validation');
const { stripHtml } = require('../../../utils/sanitize');

// The weekly spot-check: regional-prior
// hallucinations carry NO flag and mid-high confidence, so no gate sees them
// — only a human sampling published profiles measures the real error rate,
// and that rate decides whether heavier defences (two-pass generation,
// web-grounded enrichment) are ever worth building.
registerTool({
  name: 'sample_published_profiles',
  title: 'Sommelier: random sample of published AI profiles to spot-check',
  description:
    'Returns N random PUBLISHED, AI-written tasting profiles (never curator-verified or held ones) with the wine ' +
    'identity and grapes — the weekly spot-check habit. Judge each against what you actually know of the producer, ' +
    'grape and appellation; fix a wrong one with set_wine_profile (which also stamps it curator-verified). When the ' +
    'sample is done, persist the outcome with record_profile_audit — that stored corrections-per-sample rate is the ' +
    'number that decides whether stronger anti-hallucination measures are worth building.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    count: z.number().int().min(1).max(50).default(20).describe('Sample size — the weekly habit is 20'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const rows = await WineDefinition.aggregate([
      { $match: {
        nonWine: { $ne: true }, pendingIdentity: { $ne: true },
        'aiProfile.description': { $ne: null },
        'aiProfile.source': { $ne: 'curator' },
        'aiProfile.heldAt': null,
      } },
      { $sample: { size: args.count || 20 } },
      { $project: {
        name: 1, producer: 1, appellation: 1, classification: 1, type: 1, grapes: 1, region: 1,
        'aiProfile.body': 1, 'aiProfile.tannin': 1, 'aiProfile.acidity': 1,
        'aiProfile.sweetness': 1, 'aiProfile.flavors': 1, 'aiProfile.description': 1,
        'aiProfile.confidence': 1, 'aiProfile.producerUnknown': 1, 'aiProfile.searchUsed': 1,
      } },
    ]);
    await WineDefinition.populate(rows, [{ path: 'grapes', select: 'name' }, { path: 'region', select: 'name' }]);
    return ok(`${rows.length} random published AI profile(s) — judge each against producer/grape/appellation facts`, rows.map((w) => ({
      wine_id: w._id,
      name: w.name,
      producer: w.producer,
      appellation: w.appellation || null,
      region: w.region?.name || null,
      classification: w.classification || null,
      type: w.type || null,
      grapes: (w.grapes || []).map((g) => g?.name).filter(Boolean),
      profile: {
        body: w.aiProfile?.body || null,
        tannin: w.aiProfile?.tannin || null,
        acidity: w.aiProfile?.acidity || null,
        sweetness: w.aiProfile?.sweetness || null,
        flavors: w.aiProfile?.flavors || [],
        description: w.aiProfile?.description || null,
      },
      ai_confidence: w.aiProfile?.confidence ?? null,
      producer_unknown: w.aiProfile?.producerUnknown === true,
      // Judge search-assisted rows apart — their error rate is measured
      // against the un-searched population.
      ...(w.aiProfile?.searchUsed === true ? { search_assisted: true } : {}),
    })));
  },
});

// The curated core (rethink decision 3, 2026-08-18): a wine ≥N owners is the
// registry's high-traffic tier and MUST reach a curator-verified profile —
// everything outside the core may live as a labelled AI estimate
// indefinitely. This is the somm's impact-ranked worklist: owner count IS the
// priority order. (Maturity-queue wines are the core's other half and already
// have their own standing surface — list_maturity_queue.)
registerTool({
  name: 'list_unverified_core_wines',
  title: 'Sommelier: high-ownership wines still lacking a curator-verified profile',
  description:
    'The curated-core worklist, owner-count first: registry wines that at least min_owners different users own ' +
    'bottles of, whose tasting profile is NOT yet curator-verified (state: an AI profile, a held profile, or none). ' +
    'These are the wines the most people see — verify each with set_wine_profile (which stamps curator provenance) ' +
    'or judge the held ones with review_held_profile. Everything outside this core is allowed to stay a labelled AI ' +
    'estimate; this list is where proactive curation time pays best.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    min_owners: z.number().int().min(2).max(50).default(3).describe('Core threshold — the agreed default is 3 distinct owners'),
    limit: z.number().int().min(1).max(100).default(30).describe('Highest ownership first'),
    offset: z.number().int().min(0).default(0).describe('Skip this many rows — pages past 100 within one min_owners tier'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const minOwners = args.min_owners || 3;
    const owned = await Bottle.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$wineDefinition', owners: { $addToSet: '$user' } } },
      { $project: { ownerCount: { $size: '$owners' } } },
      { $match: { ownerCount: { $gte: minOwners } } },
      { $sort: { ownerCount: -1 } },
    ]);
    if (owned.length === 0) return ok(`No wines reach ${minOwners} distinct owners yet.`, []);
    const wines = await WineDefinition.find({
      _id: { $in: owned.map((o) => o._id) },
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
      'aiProfile.source': { $ne: 'curator' },
    }).select('name producer appellation region type aiProfile.description aiProfile.body aiProfile.tannin aiProfile.acidity aiProfile.sweetness aiProfile.flavors aiProfile.foodPairings aiProfile.heldAt aiProfile.heldReason aiProfile.confidence')
      .populate('region', 'name')
      .lean();
    const byId = new Map(wines.map((w) => [String(w._id), w]));
    const rows = [];
    let skipped = 0;
    for (const o of owned) {
      const w = byId.get(String(o._id));
      if (!w) continue; // curator-verified or excluded — not core work
      if (skipped < (args.offset || 0)) { skipped += 1; continue; }
      const ap = w.aiProfile || {};
      rows.push({
        wine_id: w._id,
        name: w.name,
        producer: w.producer,
        appellation: w.appellation || null,
        region: w.region?.name || null,
        type: w.type || null,
        owner_count: o.ownerCount,
        profile_state: ap.heldAt ? 'held' : (ap.description ? 'ai_published' : 'none'),
        held_reason: ap.heldReason || null,
        ai_confidence: ap.confidence ?? null,
        // The profile being judged, inline (gap report item 2 — judging 20
        // rows must not cost 20 get_wine calls). null when held/none: a held
        // row stores no content by design.
        profile: ap.description ? {
          body: ap.body || null, tannin: ap.tannin || null, acidity: ap.acidity || null,
          sweetness: ap.sweetness || null, flavors: ap.flavors || [],
          food_pairings: ap.foodPairings || [], description: ap.description,
        } : null,
      });
      if (rows.length >= (args.limit || 30)) break;
    }
    return ok(
      `${rows.length} core wine(s) (≥${minOwners} owners) without a curator-verified profile — highest ownership first` +
      (args.offset ? ` (offset ${args.offset})` : ''),
      rows
    );
  },
});

// Pending-proposal visibility (gap report item 3): propose_wine_correction
// enforces one pending proposal per (wine, kind) and 409s on a repeat — but
// nothing LISTED what was pending, so across sessions the only way to
// discover an existing proposal was to collide with it.
registerTool({
  name: 'list_pending_corrections',
  title: 'Sommelier: correction proposals already filed',
  description:
    'Lists wine-correction proposals — default the PENDING ones awaiting an admin decision — so research is never ' +
    'repeated and the one-pending-per-(wine,kind) rule stops being discovered by collision. Filter by kind ' +
    '(field_correction | merge | non_wine), wine_id, or status (pending | approved | rejected | closed — decided rows ' +
    'carry the decision and any reject reason; "closed" means the wine was merged away or deleted while the proposal ' +
    'waited, nobody judged it — the reason names the surviving record, re-file against it if the issue still applies). ' +
    'Note: MERGE proposals are filed over MCP but DECIDED in Admin → Wines on the web — deliberate, a wine merge moves ' +
    'bottles and rewrites references (same stance as taxonomy merge).',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    kind: z.enum(['field_correction', 'merge', 'non_wine']).optional(),
    wine_id: z.string().optional().describe('Only proposals for this registry wine'),
    status: z.enum(['pending', 'approved', 'rejected', 'closed']).default('pending'),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    if (args.wine_id && !isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex Mongo id.');
    const filter = { status: args.status || 'pending' };
    if (args.kind) filter.kind = args.kind;
    if (args.wine_id) filter.wineDefinition = args.wine_id;
    const [rows, total] = await Promise.all([
      WineCorrectionProposal.find(filter)
        .sort({ createdAt: -1 })
        .skip(args.offset || 0)
        .limit(args.limit || 30)
        .populate('wineDefinition', 'name producer')
        .populate('mergeTargetId', 'name producer')
        .lean(),
      WineCorrectionProposal.countDocuments(filter),
    ]);
    const label = (w) => (w ? [w.producer, w.name].filter(Boolean).join(' — ') : null);
    return ok(`${total} ${filter.status} proposal(s) (showing ${rows.length})`, rows.map((p) => ({
      proposal_id: p._id,
      wine_id: p.wineDefinition?._id || null,
      wine: label(p.wineDefinition),
      kind: p.kind,
      status: p.status,
      proposed_fields: p.proposedFields || null,
      merge_target: p.mergeTargetId ? { wine_id: p.mergeTargetId._id, wine: label(p.mergeTargetId) } : null,
      evidence_url: p.evidenceUrl || null,
      reason: p.reason,
      created_at: p.createdAt,
      ...(p.amendments && p.amendments.length
        ? { amendments: p.amendments.map((a) => ({ at: a.at, fields: a.fields || [], reason: a.reason, evidence_url: a.evidenceUrl || null })) }
        : {}),
      ...(p.status !== 'pending' ? { decided_at: p.decidedAt, reject_reason: p.rejectReason || null, applied_note: p.appliedNote || null } : {}),
    })));
  },
});

// The durable spot-check tally (gap report item 5): sample_published_profiles
// asks for a corrections-per-sample rate tracked across weeks — the number
// that decides whether heavier anti-hallucination work is worth building —
// and it previously lived only in chat.
registerTool({
  name: 'record_profile_audit',
  title: 'Sommelier: record a spot-check result (corrections per sample)',
  description:
    'Persists one sample_published_profiles outcome: how many of the sampled profiles needed correcting. The ' +
    'response returns the recent history and the running error rate, so the trend is visible immediately and the ' +
    'scaling review reads it later. Record ONE row per completed sample, right after finishing it.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    sample_size: z.number().int().min(1).max(100).describe('How many profiles were sampled (the habit is 20)'),
    corrections: z.number().int().min(0).max(100).describe('How many of them you corrected or judged wrong'),
    notes: z.string().max(500).optional().describe('Patterns seen — e.g. "2× regional-prior on Jura whites"'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    if (args.corrections > args.sample_size) {
      return fail('invalid_input', 'corrections cannot exceed sample_size.');
    }
    const ProfileAuditSample = require('../../../models/ProfileAuditSample');
    const row = await ProfileAuditSample.create({
      sampleSize: args.sample_size,
      corrections: args.corrections,
      notes: stripHtml(typeof args.notes === 'string' ? args.notes : '').slice(0, 500) || undefined,
      recordedBy: ctx.user.id,
    });
    logAudit(ctx.req, 'somm.profile.auditSample', { type: 'wine' },
      { sampleSize: args.sample_size, corrections: args.corrections, via: 'mcp' });
    const recent = await ProfileAuditSample.find({}).sort({ recordedAt: -1 }).limit(12).lean();
    const sampled = recent.reduce((n, r) => n + r.sampleSize, 0);
    const corrected = recent.reduce((n, r) => n + r.corrections, 0);
    return ok(
      `Recorded: ${args.corrections}/${args.sample_size} corrected. Running rate over the last ${recent.length} sample(s): ${corrected}/${sampled} (${sampled ? Math.round((corrected / sampled) * 100) : 0}%).`,
      {
        recorded: { sample_size: row.sampleSize, corrections: row.corrections, at: row.recordedAt },
        running_rate_pct: sampled ? Math.round((corrected / sampled) * 1000) / 10 : 0,
        history: recent.map((r) => ({ at: r.recordedAt, sample_size: r.sampleSize, corrections: r.corrections, notes: r.notes || null })),
      }
    );
  },
});
