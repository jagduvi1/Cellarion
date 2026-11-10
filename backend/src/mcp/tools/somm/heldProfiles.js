// Sommelier tools: the held-profile review queue (list_held_profiles,
// review_held_profile) and, because it sits between them and the proposals in
// the tool order, the spot-check trend read (list_profile_audits).
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const WineDefinition = require('../../../models/WineDefinition');
const Bottle = require('../../../models/Bottle');
const aiConfig = require('../../../config/aiConfig');
const { registerTool } = require('../../registry');
const { ok, fail, objectId, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { isValidId } = require('../../../utils/validation');
const { stripHtml } = require('../../../utils/sanitize');
const { hasProfileContent, UNPROFILED_QUERY } = require('../../../utils/profileReview');
const heldProfileOps = require('../../../services/heldProfileOps');

// ── The held-profile review queue over MCP ──────────────────────────────────
// The publication gate holds profiles; judging those holds must be possible
// over MCP, not only in the web admin queue. One list + one decision verb,
// and every decision path leaves the row OUT of the queue by construction —
// a release path that skips the profileReviewedAt stamp leaves rows stuck
// unstamped, and this surface must not create that bug.

const HELD_LIST_CAP = 500;
// What still needs judging: held rows unreviewed since generation, published
// suspects with no verdict. Defined with the other review predicates in
// utils/profileReview.js, which says why the two states cannot share a marker.
const { HELD_QUEUE_OUTSTANDING_EXPR } = require('../../../utils/profileReview');

registerTool({
  name: 'list_held_profiles',
  title: 'Sommelier: profiles held by the publication gate, awaiting judgement',
  description:
    'Rows carrying open_owner_inquiry have already been escalated to the person holding the bottle by a previous ' +
    'curator who judged research insufficient — read that question before deciding, because a release or uphold ' +
    'over the top of it discards the escalation and the row can then only be settled on the evidence that was ' +
    'already not enough. It is not a block: new evidence beats a pending question, and resolve_owner_inquiry closes ' +
    'it honestly. ' +
    'The hold-review queue: registry wines whose generated tasting profile is HELD unpublished (producer_suspect / ' +
    'low_confidence / unknown_low_confidence / producer_claim / taxonomy_conflict / grape_colour_conflict — ' +
    'held_reason says which; null on rows held before the field existed; for taxonomy_conflict the producer_note ' +
    'carries the computed detail, e.g. "bacchus is defined by low acidity; profile says high", and for ' +
    'grape_colour_conflict it names the clash, e.g. "stored red, but every grape is white (Sauvignon Blanc)" — ' +
    'that one is a fact about the RECORD, not the model, so the fix is an identity edit: either the type or the ' +
    'grape list is wrong, and the note does not presume which). A held row stores NO profile content by design — ' +
    'publication withheld means never written, which is why release REGENERATES rather than publishing something ' +
    'stored. include_published_suspects:true ALSO lists the published rows whose producer the model flagged as ' +
    'suspect — same judgement work, different state. Owner-count rides on every row and the list ' +
    'is impact-first (owners desc, then confidence asc). Judge each with review_held_profile; rows you have decided ' +
    'disappear from this list. ' +
    'This is also the INTAKE queue: a registry wine with no profile at all appears here as state "unprofiled" — no ' +
    'flags, no confidence, just a wine awaiting its first profile. When this server has automatic AI profiles ' +
    'switched off (wine data is somm-owned), every new registry wine lands here and nothing else writes its ' +
    'profile. Write it with set_wine_profile (type/grape fixes ride the same call); identity gaps go through ' +
    'propose_wine_correction as usual. state:"unprofiled" lists only these.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    held_reason: z.string().max(40).optional().describe('Filter the HELD set to one reason (e.g. "taxonomy_conflict"); "legacy" = rows with no recorded reason'),
    state: z.enum(['held', 'published_suspect', 'unprofiled']).optional()
      .describe('One state only. "unprofiled" = wines with NO profile at all — with automatic AI profiles switched off every new wine lands here, and set_wine_profile is how it leaves. Omit for all states.'),
    include_published_suspects: z.boolean().optional().describe('Also list PUBLISHED producer-suspect rows awaiting judgement (state "published_suspect")'),
    producer: z.string().max(200).optional().describe('Only rows whose producer contains this text (case-insensitive) — the queue clusters hard by producer, and one producer judgement often decides many rows'),
    group_by: z.enum(['producer']).optional().describe('Return producer CLUSTERS instead of rows: {producer, row_count, reasons, max_owner_count, wine_ids} — the unit of judgement is usually the producer'),
    counts_only: z.boolean().optional().describe('Uncapped totals by state, held_reason and owner-tier — sizes the real backlog without paging'),
    min_owners: z.number().int().min(0).max(50).optional().describe('Only rows at least this many distinct users own bottles of'),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    // Three states, three $or branches, each gated by the `state` filter.
    // held and published_suspect require generatedAt (a profile must exist to
    // be held or suspect); unprofiled is the intake queue: when automatic
    // AI enrichment is OFF (somm-owned data), a new wine arrives with NO
    // profile at all and this list is the only place the somm can see it.
    // `description: null` keeps curator rows that predate the generatedAt
    // stamp out of the unprofiled state — a wine with a written description
    // is not awaiting a profile.
    const wantState = (s) => args.state === undefined || args.state === s;
    const or = [];
    if (wantState('held')) {
      or.push({ 'aiProfile.heldAt': { $ne: null }, 'aiProfile.generatedAt': { $ne: null } });
    }
    // An explicit state ask implies the include flag — asking for suspects
    // and getting nothing because a second switch was off would be a trap.
    // counts_only implies it too: the listing default
    // exists to keep suspects out of a curator's held-row PAGING, but a count
    // has no paging to protect — carrying the default into it would report
    // published_suspect as a hard 0 (not "uncounted") and under-size the
    // backlog. A count counts every state.
    if (((args.include_published_suspects || args.counts_only) && wantState('published_suspect')) || args.state === 'published_suspect') {
      // An empty description is no content: review_held_profile reads it that
      // way, so a row listed here must be one it can decide.
      or.push({ 'aiProfile.heldAt': null, 'aiProfile.generatedAt': { $ne: null }, 'aiProfile.producerSuspect': true, 'aiProfile.description': { $nin: [null, ''] } });
    }
    if (wantState('unprofiled')) {
      // The Mongo form of hasProfileContent, shared with list_maturity_queue.
      or.push(UNPROFILED_QUERY);
    }
    const match = {
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
      $or: or,
      $expr: HELD_QUEUE_OUTSTANDING_EXPR, // a decided row is done — never re-listed
    };
    if (args.producer) {
      match.producer = { $regex: args.producer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }
    const stateOf = (w) => {
      if (w.aiProfile?.heldAt) return 'held';
      // A published suspect is identified by having CONTENT. Shared with
      // list_maturity_queue's profileLite via hasProfileContent, so the two
      // tools can never again disagree about whether a profile exists.
      // (The query's unprofiled branch above is the same test written in Mongo.)
      if (hasProfileContent(w.aiProfile)) return 'published_suspect';
      return 'unprofiled';
    };
    const reasonKey = (w) => (w.aiProfile?.heldAt ? (w.aiProfile?.heldReason || 'legacy') : stateOf(w));
    const ownerCounts = async (ids) => {
      if (ids.length === 0) return new Map();
      const owned = await Bottle.aggregate([
        { $match: { status: 'active', wineDefinition: { $in: ids } } },
        { $group: { _id: '$wineDefinition', owners: { $addToSet: '$user' } } },
        { $project: { ownerCount: { $size: '$owners' } } },
      ]);
      return new Map(owned.map((o) => [String(o._id), o.ownerCount]));
    };

    // Uncapped backlog sizing (gap report 5a): id+reason projection only, so
    // "how big is this really" never depends on the row cap.
    if (args.counts_only) {
      const idRows = await WineDefinition.find(match).select('aiProfile.heldAt aiProfile.heldReason aiProfile.generatedAt').lean();
      const heldByReason = {};
      const byState = { held: 0, published_suspect: 0, unprofiled: 0 };
      for (const r of idRows) {
        byState[stateOf(r)] += 1;
        if (!r.aiProfile?.heldAt) continue;
        const k = r.aiProfile.heldReason || 'legacy';
        heldByReason[k] = (heldByReason[k] || 0) + 1;
      }
      const cmap = await ownerCounts(idRows.map((r) => r._id));
      const tiers = { 0: 0, 1: 0, 2: 0, '3+': 0 };
      for (const r of idRows) {
        const c = cmap.get(String(r._id)) || 0;
        tiers[c >= 3 ? '3+' : c] += 1;
      }
      return ok(
        `${idRows.length} total awaiting work — ${byState.held} held, ${byState.published_suspect} published_suspect, ${byState.unprofiled} unprofiled (uncapped)`,
        { total: idRows.length, held: byState.held, published_suspect: byState.published_suspect, unprofiled: byState.unprofiled, held_by_reason: heldByReason, by_owner_tier: tiers }
      );
    }

    // Producer clusters (gap report 2): the queue arrives in import bursts and
    // clusters by producer — "is Thomas Allen a real winery?" decides nine
    // rows at once. Uncapped scan on a three-field projection.
    if (args.group_by === 'producer') {
      const rows = await WineDefinition.find(match).select('producer aiProfile.heldAt aiProfile.heldReason aiProfile.generatedAt').lean();
      const groups = new Map();
      for (const r of rows) {
        const key = r.producer || '(no producer)';
        let g = groups.get(key);
        if (!g) { g = { producer: key, row_count: 0, reasons: {}, wine_ids: [] }; groups.set(key, g); }
        g.row_count += 1;
        const k = reasonKey(r);
        g.reasons[k] = (g.reasons[k] || 0) + 1;
        if (g.wine_ids.length < 50) g.wine_ids.push(r._id);
      }
      const cmap = await ownerCounts(rows.map((r) => r._id));
      for (const g of groups.values()) {
        g.max_owner_count = g.wine_ids.reduce((m, id) => Math.max(m, cmap.get(String(id)) || 0), 0);
      }
      const shaped = [...groups.values()]
        .sort((a, b) => b.row_count - a.row_count)
        .slice(args.offset || 0, (args.offset || 0) + (args.limit || 30));
      return ok(`${groups.size} producer cluster(s) over ${rows.length} row(s) — largest first`, shaped);
    }

    const rows = await WineDefinition.find(match)
      .select('name producer appellation type grapes country region aiProfile.confidence aiProfile.heldAt aiProfile.heldReason aiProfile.producerSuspect aiProfile.producerUnknown aiProfile.producerNote aiProfile.description aiProfile.generatedAt aiProfile.searchUsed')
      .limit(HELD_LIST_CAP)
      .populate('grapes', 'name')
      .populate('country', 'name')
      .populate('region', 'name')
      .lean();

    const wanted = rows.filter((w) => {
      const held = !!w.aiProfile?.heldAt;
      if (!held) return true; // published_suspect and unprofiled rows pass the reason filter untouched
      if (!args.held_reason) return true;
      if (args.held_reason === 'legacy') return !w.aiProfile?.heldReason;
      return w.aiProfile?.heldReason === args.held_reason;
    });

    const counts = await ownerCounts(wanted.map((w) => w._id));

    // An OPEN owner inquiry means a previous curator judged that research
    // could not settle this row and asked the person holding the bottle;
    // releasing the profile over the top of it throws that question away.
    // Surfacing it here is the cheap half of the fix — the expensive half would be
    // blocking the verbs, and blocking is wrong: the curator may have new
    // evidence the inquiry was waiting for.
    const WineOwnerInquiry = require('../../../models/WineOwnerInquiry');
    const openInquiries = new Map(
      (await WineOwnerInquiry.find({
        wineDefinition: { $in: wanted.map((w) => w._id) },
        status: 'open',
      }).select('wineDefinition question createdAt expiresAt').lean())
        .map((i) => [String(i.wineDefinition), i])
    );

    const shaped = wanted
      .map((w) => ({
        wine_id: w._id,
        name: w.name,
        producer: w.producer,
        appellation: w.appellation || null,
        type: w.type || null,
        // Registry facts, not generated content (gap report 4): the "held rows
        // store no profile" rule is about the PROFILE — grapes and country are
        // what the curator judges hand-curatability with.
        grapes: (w.grapes || []).map((g) => g?.name).filter(Boolean),
        country: w.country?.name || null,
        // Region carries the judgement a country cannot (Hunter Valley vs
        // "Australia") — and note: regeneration
        // writes ONLY the aiProfile subdoc, it can never set region or any
        // identity field; those stay behind the proposal gate.
        region: w.region?.name || null,
        state: stateOf(w),
        held_reason: w.aiProfile?.heldAt ? (w.aiProfile?.heldReason || null) : null,
        producer_suspect: w.aiProfile?.producerSuspect === true,
        producer_unknown: w.aiProfile?.producerUnknown === true,
        producer_note: w.aiProfile?.producerNote || null,
        ai_confidence: w.aiProfile?.confidence ?? null,
        owner_count: counts.get(String(w._id)) || 0,
        generated_at: w.aiProfile?.generatedAt || null,
        // A web-search retry already failed on this row —
        // releasing it without curator facts would just re-hold.
        ...(w.aiProfile?.searchUsed === true ? { search_assisted: true } : {}),
        // A previous curator already escalated this row to its owner; deciding
        // over the top of that discards the escalation.
        ...(openInquiries.has(String(w._id)) ? {
          open_owner_inquiry: {
            inquiry_id: String(openInquiries.get(String(w._id))._id),
            question: openInquiries.get(String(w._id)).question || null,
            asked_at: openInquiries.get(String(w._id)).createdAt || null,
            expires_at: openInquiries.get(String(w._id)).expiresAt || null,
          },
        } : {}),
      }))
      .filter((r) => !args.min_owners || r.owner_count >= args.min_owners)
      .sort((a, b) => (b.owner_count - a.owner_count) || ((a.ai_confidence ?? 1) - (b.ai_confidence ?? 1)));

    const page = shaped.slice(args.offset || 0, (args.offset || 0) + (args.limit || 30));
    return ok(
      `${shaped.length} profile(s) awaiting judgement (showing ${page.length}, impact-first)` +
      (rows.length >= HELD_LIST_CAP ? ` — capped at ${HELD_LIST_CAP} rows scanned; counts_only:true gives uncapped totals` : ''),
      page
    );
  },
});

registerTool({
  name: 'review_held_profile',
  title: 'Sommelier: decide one held/flagged profile — release, confirm, uphold, or reject',
  description:
    'The decision verb for list_held_profiles. decision "release" (HELD rows): the doubt was unfounded — the ' +
    'profile REGENERATES under the human override and publishes; costs one AI call, and on generation failure the ' +
    'row simply stays in the queue for another try. When this server has automatic AI profiles switched off (wine ' +
    'data is sommelier-owned), release is refused: write the profile with set_wine_profile instead, which replaces ' +
    'the held one and clears the hold in one step. decision "confirm": the CURRENT state is correct — a held row ' +
    'stays held (its owner keeps seeing "Not yet assessed"), a published_suspect row stays published WITH THE ' +
    'SUSPECT FLAG CLEARED (a human adjudicated the doubt away), and producerUnknown clears too when set — confirm ' +
    'also works on a published row whose ONLY doubt flag is producerUnknown ("I have placed this producer"; the ' +
    'route a documented estate needed once its profile was fixed but the flag had no verb), and on a row a RULE ' +
    'moved out of the suspect queue with no flag left at all (list_rule_downgrades): confirm records the placement, ' +
    'clears the rule tag and the row leaves that list. decision "uphold" ' +
    '(published_suspect rows only): ' +
    'the flag is CORRECT — the producer value really is a brand/style/non-winery — so the row stays published, ' +
    'KEEPS the flag and the owner-visible caveat, and leaves the queue as the registry\'s honest residue; ' +
    'upheld-count is the true cannot-identify number the scaling review reads. decision "reject" (HELD rows only): ' +
    'this generation is garbage — the profile clears entirely and the wine returns to the enrichment pool (with ' +
    'automatic AI profiles off, nothing regenerates it — write it with set_wine_profile). Every ' +
    'path removes the row from the queue by construction — release/confirm/uphold stamp profileReviewedAt, reject ' +
    'clears the generation itself. To instead WRITE the correct profile yourself, use set_wine_profile.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.optional().describe('One wine, from list_held_profiles'),
    wine_ids: z.array(z.string()).min(1).max(40).optional().describe('BATCH confirm/uphold/reject (one call, per-row results). release is deliberately single-wine — it spends an AI call and takes curator context'),
    decision: z.enum(['release', 'confirm', 'uphold', 'reject']),
    reason: z.string().max(300).optional().describe('Why — recorded in the audit trail (applies to every row of a batch)'),
    context: z.string().max(1000).optional().describe('release only: curator-supplied ground truth injected into the regeneration prompt — the one or two facts the model was missing (e.g. "Hunter Valley, dry-farmed vines planted 1969; The Mango Tree cuvée = Chardonnay")'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const reason = stripHtml(typeof args.reason === 'string' ? args.reason : '').slice(0, 300) || null;
    const context = stripHtml(typeof args.context === 'string' ? args.context : '').slice(0, 1000) || null;
    const ids = args.wine_ids || (args.wine_id ? [args.wine_id] : []);
    if (ids.length === 0) return fail('invalid_input', 'Provide wine_id or wine_ids.');
    if (args.wine_id && args.wine_ids) return fail('invalid_input', 'Provide wine_id OR wine_ids, not both.');
    if (args.wine_ids && args.decision === 'release') {
      return fail('invalid_input', 'release is one wine at a time — it regenerates via an AI call and is where curator context belongs. Batch is for confirm/reject.');
    }
    if (context && args.decision !== 'release') {
      return fail('invalid_input', 'context only applies to decision "release" — it feeds the regeneration prompt.');
    }
    for (const id of ids) {
      if (!isValidId(id)) return fail('invalid_input', `Not a valid wine id: ${id}`);
    }

    // One wine, one decision — the service body shared by the single and
    // batch paths, so the semantics and the stamp rule cannot fork
    // (services/heldProfileOps). It returns { wine_id, error } strings for
    // the refusals, which this tool words below.
    const decideOne = (id) => heldProfileOps.decideHeldProfile(id, args.decision, { reason, context, req: ctx.req, via: 'mcp' });

    if (!args.wine_ids) {
      const r = await decideOne(ids[0]);
      if (r.error === 'not_found') return fail('not_found', 'No registry wine with that id.');
      if (r.error === 'nothing_to_review') return fail('invalid_input', 'This wine has no held or suspect-flagged profile to review — list_held_profiles shows the queue.');
      if (r.error) {
        const unavailable = r.error.startsWith('generation_failed') || r.error.startsWith('ai_profiles_off');
        return fail(unavailable ? 'unavailable' : 'invalid_input', `${r.error} (${ids[0]})`);
      }
      const msg = r.decision === 'release'
        ? `Released and published the held profile for ${r.label} (regenerated under the human override${context ? ', with curator context' : ''}; review stamped).`
        : r.decision === 'confirm'
          ? (r.state === 'held'
            ? `Confirmed the hold on ${r.label} — it stays unpublished (owners see "Not yet assessed") and leaves the queue.`
            // Built from what this confirm actually cleared, not one sentence
            // for every published state.
            : `Confirmed ${r.label} as published` +
              (r.suspect_cleared ? ' — the suspect flag is CLEARED (a human adjudicated the doubt)' : '') +
              (r.unknown_cleared ? ' — producer placed (producerUnknown cleared)' : '') +
              (r.rule_cleared ? ` — the ${r.rule_cleared} tag is cleared; it leaves list_rule_downgrades` : '') +
              (r.producer_note_cleared ? '; the producer note went with the flag (kept in the audit row).' : '.'))
          : r.decision === 'uphold'
            ? `Upheld the flag on ${r.label} — stays published WITH the caveat, review stamped; the row is now honest residue, not queue.`
            : aiConfig.get().enrichmentOnAdd === 'off'
              // Somm-owned data: nothing regenerates it, so "a fresh attempt"
              // would tell the curator to wait for a profile that never comes.
              ? `Rejected the held generation for ${r.label} — profile cleared. Automatic AI profiles are off on this server, so nothing will regenerate it: write it with set_wine_profile.`
              : `Rejected the held generation for ${r.label} — profile cleared; the wine returns to the enrichment pool for a fresh attempt.`;
      const { label, ...data } = r;
      return ok(msg, data);
    }

    const results = [];
    for (const id of ids) results.push(await decideOne(id));
    const done = results.filter((r) => !r.error).length;
    return ok(`Batch ${args.decision}: ${done}/${ids.length} decided, ${ids.length - done} skipped (per-row detail attached).`,
      results.map(({ label, ...r }) => r));
  },
});

// Read-only trend access (gap report 5b): record_profile_audit returns the
// history only as a side effect of WRITING a row — reading the trend must
// not require polluting the series with a dummy sample.
registerTool({
  name: 'list_profile_audits',
  title: 'Sommelier: spot-check history and running error rate',
  description:
    'The recorded sample_published_profiles outcomes, newest first, with the running corrections-per-sample rate — ' +
    'the trend the scaling review reads. Read-only twin of record_profile_audit.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(12),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const ProfileAuditSample = require('../../../models/ProfileAuditSample');
    const rows = await ProfileAuditSample.find({}).sort({ recordedAt: -1 }).limit(args.limit || 12).lean();
    const sampled = rows.reduce((n, r) => n + r.sampleSize, 0);
    const corrected = rows.reduce((n, r) => n + r.corrections, 0);
    return ok(
      rows.length === 0
        ? 'No spot-checks recorded yet — run sample_published_profiles, then record_profile_audit.'
        : `${rows.length} sample(s): ${corrected}/${sampled} corrected (${Math.round((corrected / sampled) * 100)}%).`,
      {
        running_rate_pct: sampled ? Math.round((corrected / sampled) * 1000) / 10 : 0,
        history: rows.map((r) => ({ at: r.recordedAt, sample_size: r.sampleSize, corrections: r.corrections, notes: r.notes || null })),
      }
    );
  },
});
