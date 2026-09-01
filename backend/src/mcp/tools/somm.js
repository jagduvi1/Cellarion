// Sommelier MCP tools (plan Phase-2 somm note, per Johan): queue listing +
// data entry for the SHARED recommendation data a somm curates. The killer
// workflow: "anything in my maturity queue?" → set the windows → next.
//
// Role gating is STRUCTURAL: every tool here declares requireRole, so the
// registry never even advertises them to non-somm callers (mcp/registry.js).
// A defense-in-depth role re-check runs inside each handler anyway — the two
// layers can only drift safely.
//
// Audit action strings are IDENTICAL to the REST somm routes (somm.maturity.
// review, somm.price.add) so REST and MCP curation audit identically.
const { z } = require('zod');
const mongoose = require('mongoose');
const WineVintageProfile = require('../../models/WineVintageProfile');
const WineVintagePrice = require('../../models/WineVintagePrice');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../../models/PriceTrackingSkip');
const WineDefinition = require('../../models/WineDefinition');
const aiConfig = require('../../config/aiConfig');
const Bottle = require('../../models/Bottle');
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const WineOwnerInquiry = require('../../models/WineOwnerInquiry');
const { registerTool } = require('../registry');
const { logAudit } = require('../../services/audit');
const { SUPPORTED_CURRENCIES } = require('../../config/currencies');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');
const { normalizeString, sanitizeTaxonomyName } = require('../../utils/normalize');
const { classifyProposal } = require('../../services/proposalDirectApply');
const { ok, fail, objectId, pageParams } = require('../toolUtil');
const { logAction } = require('../actionLedger');
const {
  PROFILE_ENUMS,
  WINE_TYPES,
  GRAPES_MAX,
  GRAPE_NAME_MAX,
  validateProfilePatch,
  resolveGrapeIdsStrict,
  applyProfilePatch,
  snapshotProfile,
} = require('../../services/wineProfileOps');
const {
  QUESTION_MIN,
  QUESTION_MAX,
  NOTE_MIN,
  NOTE_MAX,
  OWNER_REPLY_MAX,
  createOwnerInquiry,
  resolveOwnerInquiry,
  sweepExpiredInquiries,
  queryInquiryPage,
} = require('../../services/ownerInquiryOps');
const {
  queryPendingWines,
  validatePendingFix,
  applyPendingFix,
  loadPendingWine,
  CREATED_VIA_FILTERS,
  FIELD_MAX,
  MAX_BOTTLE_IMAGES,
} = require('../../services/pendingWineOps');
const { closeWineReport, MAX_RESPONSE } = require('../../services/wineReportOps');
const WineReport = require('../../models/WineReport');
// services/search is required lazily at call time, not here: it pulls in the
// Meili client and half the model layer at module load, which every consumer
// of the tool registry would then have to stand up (registry.test.js does not).

const SOMM_ROLES = ['somm', 'admin'];
const PHASE_FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];
const PRICE_STALE_MS = 90 * 24 * 60 * 60 * 1000; // mirror routes/somm/prices.js

function requireSomm(ctx) {
  const roles = ctx.user?.roles || [];
  return SOMM_ROLES.some((r) => roles.includes(r))
    ? null
    : fail('forbidden_scope', 'This tool needs the sommelier (or admin) role.');
}

const wineLite = (wd) => (wd ? {
  wine_id: wd._id,
  name: wd.name,
  producer: wd.producer || null,
  type: wd.type || null,
  country: wd.country?.name || null,
  region: wd.region?.name || null,
  appellation: wd.appellation || null,
  // Somm ticket 6a887619 (2026-08-21): every OTHER identity field showed here
  // but grapes did not, so grapes written at wine creation became visible only
  // on a later get_wine — and read as "populated by an unidentified path
  // during curation". Four instances were filed before the cause was found.
  //
  // Emitted HONESTLY or not at all. Callers differ in what they select and
  // populate, and an unpopulated ref array must not collapse to `grapes: []` —
  // that is a claim of "no grapes" on a wine that has them, which is the exact
  // shape of misreading this ticket came from. So: populated docs → names;
  // a genuinely empty array → []; unpopulated ids or an unselected field →
  // the key is omitted, meaning "not carried on this surface".
  // Output-only change: no reconnect needed.
  ...(grapesLite(wd.grapes)),
  ...(provenanceLite(wd.identityProvenance)),
} : null);

/**
 * Which identity fields a MODEL supplied rather than a person.
 *
 * Emitted as a list of field names, and only when at least one qualifies —
 * the common case is a wine nobody needs warned about, and a key reading
 * `inferred_fields: []` on every row is noise a curator learns to skip.
 *
 * Somm ticket 6a958dbc (2026-08-31): a 205-row import whose file carried
 * appellation on every row and grapes on none produced wines whose grapes had
 * been inferred by the model FROM the appellation — all eight Montlouis wines
 * came out Chenin Blanc, including a pétillant naturel that is mostly Menu
 * Pineau. The values were wrong, mutually consistent and indistinguishable
 * from researched ones, so the curator had to stop work entirely. This is the
 * missing signal: not "this is wrong", but "nobody asserted this".
 */
const provenanceLite = (provenance) => {
  if (!provenance) return {};
  // Mongoose Map on a hydrated doc, plain object on a .lean() one.
  const entries = typeof provenance.entries === 'function'
    ? [...provenance.entries()]
    : Object.entries(provenance);
  const inferred = entries.filter(([, source]) => source === 'model').map(([field]) => field).sort();
  return inferred.length ? { inferred_fields: inferred } : {};
};

const grapesLite = (grapes) => {
  if (!Array.isArray(grapes)) return {};
  const names = grapes.map((g) => g?.name).filter(Boolean);
  if (grapes.length > 0 && names.length === 0) return {}; // ids, not docs
  return { grapes: names };
};

// The tasting profile as a curator needs to judge it: the values, plus WHO
// wrote them and how sure the generator was. `confidence` is the model's own
// self-rating and is not a correctness score — a 0.6 profile inverted the
// facts about a Vintage Port — so it is labelled, not thresholded.
// A HELD profile carries the doubt but no prose, which made it look exactly
// like a wine that was never enriched — the curator could not tell whether a
// missing tasting note meant "not generated yet" or "generated and withheld
// from the owner", and said so (somm ticket 6a82bfb7). It reports itself now.
//
// producer_unknown rides along on every shape: it is the difference between
// "this record is wrong" and "this is a small estate the model cannot place",
// and a curator judging a drink window should know which they are looking at.
/**
 * Does a stored profile EXIST — by content, not by who wrote it.
 *
 * generatedAt is the AI's stamp: a curator-written profile never has one, so
 * testing generatedAt alone reports every hand-written profile as absent. That
 * is exactly what list_maturity_queue did (somm ticket 6a911643, 2026-08-28):
 * on production 1,769 of 2,113 curator profiles carry no generatedAt, and the
 * queue told curators all of them were blank — with a reason string that
 * instructed them to write one. Following it in good faith overwrote another
 * curator's research and restamped it as their own, and set_wine_profile
 * accepted the write without complaint.
 *
 * list_held_profiles had already got this right ("a published suspect is
 * identified by having CONTENT — generatedAt or a written description"), which
 * is why the somm's workaround of trusting that tool instead worked. The two
 * readers now share this one predicate so they cannot drift apart again. The
 * Mongo-side unprofiled branch in list_held_profiles is the same test written
 * as a query, and is commented to point back here.
 *
 * @param {object} ap  aiProfile subdoc (lean or hydrated)
 */
const hasProfileContent = (ap) => !!(ap && (ap.generatedAt || ap.description || ap.body));

/**
 * @param {object} ap    aiProfile subdoc
 * @param {object} wine  the wine, for the absent-profile explanation
 */
const profileLite = (ap, wine) => {
  // NO PROFILE. This used to be a silent null meaning "the batch has not
  // reached it yet". Since the enrichmentOnAdd policy (2026-08-21) it usually
  // means automatic enrichment DECLINED the record — permanently, for a
  // record too thin to say anything true — so the curator writing the drink
  // window is the one who will write the profile. A null could not say that.
  if (!hasProfileContent(ap)) {
    const { identityDataSufficient } = require('../../services/enrichmentJob');
    // Degrade to the softer message rather than throwing: this runs inside a
    // row mapper, so a missing export would take out the whole queue listing
    // over a cosmetic label.
    const thin = wine && typeof identityDataSufficient === 'function'
      ? !identityDataSufficient({ ...wine, grapes: wine.grapes || [] })
      : false;
    // auto_enrich must describe what will ACTUALLY happen. "pending" was
    // hard-coded, and read as "someone else will write this" — but automatic
    // enrichment has been switched off in production since 2026-08-22, so
    // nothing was ever coming. A value that names a future that will not
    // arrive is worse than no value: it tells the curator to wait.
    const mode = aiConfig.get().enrichmentOnAdd;
    let autoEnrich;
    let reason;
    if (thin) {
      autoEnrich = 'skipped_thin_identity';
      reason = 'no region or appellation on the record, so automatic enrichment skips it — this profile is yours to write';
    } else if (mode === 'off') {
      autoEnrich = 'off';
      reason = 'automatic enrichment is switched off, so nothing will write this — the profile is yours to write';
    } else {
      autoEnrich = 'pending';
      reason = 'not enriched yet';
    }
    return { absent: true, reason, auto_enrich: autoEnrich };
  }
  if (ap.heldAt) {
    return {
      withheld: true,
      withheld_reason: ap.producerNote
        || (ap.heldReason === 'low_confidence' || ap.heldReason === 'unknown_low_confidence'
          ? 'generated below the publication confidence floor; awaiting review'
          : 'the producer field does not look like a real winery; awaiting review'),
      // Machine-readable WHY (gate 2026-08-18): 'producer_suspect' |
      // 'low_confidence' | 'unknown_low_confidence' | 'producer_claim'.
      // null on rows held before the field existed (producer_suspect era).
      held_reason: ap.heldReason || null,
      producer_suspect: ap.producerSuspect === true,
      producer_unknown: ap.producerUnknown === true,
      ai_confidence: ap.confidence ?? null,
      description: null,
      source: ap.source || 'ai',
      // Pilot 2026-08-19: a search-assisted retry ALSO failed the gate — this
      // row's doubt survived a web search, so releasing it needs real curator
      // facts, not another plain regeneration.
      ...(ap.searchUsed === true ? { search_assisted: true } : {}),
    };
  }
  if (!(ap.description || ap.body)) return null;
  return {
    body: ap.body || null,
    tannin: ap.tannin || null,
    acidity: ap.acidity || null,
    sweetness: ap.sweetness || null,
    flavors: ap.flavors || [],
    food_pairings: ap.foodPairings || [],
    description: ap.description || null,
    source: ap.source || 'ai',
    ai_confidence: ap.source === 'curator' ? null : (ap.confidence ?? null),
    // Present on AI profiles so the curator can weigh the prose: an
    // unplaceable producer means the note is appellation-level typicity, not
    // knowledge of this house.
    producer_suspect: ap.producerSuspect === true,
    producer_unknown: ap.producerUnknown === true,
    producer_note: ap.producerNote || null,
    verified_at: ap.verifiedAt || null,
    // Pilot 2026-08-19: this profile came from the web-search rescue retry.
    // Flagged so quality judgements on searched rows can be tallied apart —
    // the pilot's go/no-go number. Omitted when false to keep payloads lean.
    ...(ap.searchUsed === true ? { search_assisted: true } : {}),
  };
};

registerTool({
  name: 'list_maturity_queue',
  title: 'Sommelier: list the maturity queue',
  description:
    'Lists wine+vintage pairs awaiting drink-window review (every added bottle seeds one). Pending first, newest ' +
    'first. Call when the somm asks "anything in my maturity queue?" or before a review session. Pass wine_id ' +
    '(and optionally vintage) to fetch ONE wine\'s rows — including curator notes, which the public drink_window_for ' +
    'deliberately omits; a wine-scoped call defaults to status "all" so reviewed rows show without paginating the ' +
    'whole queue. Use the returned profile_id with set_vintage_maturity (which also accepts wine_id + vintage directly). ' +
    'THIS QUEUE IS A TWO-OUTPUT PASS: the research you do to set a drink window — the producer, the vintage, the ' +
    'style — is the same research a tasting profile needs, so write both while you have it. Read tasting_profile on ' +
    'each row: absent:true means NO profile is stored — neither AI-generated nor curator-written (a curator profile ' +
    'is reported in full, with source "curator"). auto_enrich says what will happen to an absent one: ' +
    '"skipped_thin_identity" — no region or appellation, automatic enrichment deliberately declines those; "off" — ' +
    'automatic enrichment is switched off, nothing is coming; "pending" — it may still be enriched. In the first two ' +
    'cases nothing will ever write it but you. withheld:true means a generated profile exists but is held for the ' +
    'stated reason — judge it through list_held_profiles rather than overwriting blind. Write with set_wine_profile.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    status: z.enum(['pending', 'reviewed', 'all']).optional()
      .describe('Default: "pending" — or "all" when wine_id is given (a wine lookup wants every row)'),
    wine_id: objectId.optional().describe('Scope to one registry wine (from search_registry/get_wine/drink_window_for)'),
    vintage: z.string().min(1).max(10).optional().describe('With wine_id: one vintage, e.g. "2019" or "NV"'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { limit, offset } = pageParams(args, 20, 50);
    // A wine-scoped call defaults to 'all': the curator asking "what is
    // curated for THIS wine" wants reviewed rows, and 5,600+ reviewed
    // profiles made reaching one by pagination ~113 calls (curator feedback
    // on v1.101.0). Unscoped calls keep the pending-queue default.
    const status = args.status || (args.wine_id ? 'all' : 'pending');
    const filter = status === 'all' ? {} : { status };
    if (args.wine_id) {
      filter.wineDefinition = args.wine_id;
      if (args.vintage) {
        // Same canonical vintage form set_vintage_maturity uses.
        filter.vintage = /^nv$/i.test(args.vintage.trim()) ? 'NV' : args.vintage.trim();
      }
    }
    const [total, pending, profiles] = await Promise.all([
      WineVintageProfile.countDocuments(filter),
      WineVintageProfile.countDocuments({ status: 'pending' }),
      WineVintageProfile.find(filter)
        .sort({ status: 1, createdAt: -1 })
        .skip(offset).limit(limit)
        // grapes rides along for identityDataSufficient, which decides whether
        // an absent profile is "yours to write" or merely "not yet enriched".
        // grapes populated to NAMES, not just selected as ids: the queue row
        // is where the curator decides whether a wine needs work, and grapes
        // invisible here is what ticket 6a887619 mistook for a phantom writer.
        .populate({ path: 'wineDefinition', select: 'name producer type appellation aiProfile grapes identityProvenance', populate: ['country', 'region', { path: 'grapes', select: 'name' }] })
        .lean(),
    ]);
    const data = profiles.map((p) => ({
      profile_id: p._id,
      wine: wineLite(p.wineDefinition),
      vintage: p.vintage,
      status: p.status,
      relative_nv: !!p.relative,
      phases: PHASE_FIELDS.reduce((acc, f) => ((acc[f] = p[f] ?? null), acc), {}),
      // The generated tasting profile the curator is about to judge the drink
      // window against. Returned so a wrong one can be corrected in the same
      // pass with set_wine_profile, instead of the curator silently working
      // around it and the bad prose surviving (support ticket 2026-07-28).
      // `source` tells the model whether a human has already vetted this.
      tasting_profile: profileLite(p.wineDefinition?.aiProfile, p.wineDefinition),
      // Somm-gated tool, so the curator's own note comes back with the row.
      // Kept out of drink_window_for, which is public — see publicContent.js.
      somm_notes: p.sommNotes || null,
    }));
    return ok(`${pending} pending in the maturity queue (showing ${data.length} of ${total} ${status})`, data, {
      page: { limit, offset, total },
    });
  },
});

registerTool({
  name: 'set_vintage_maturity',
  title: 'Sommelier: set a vintage\'s drink-window phases',
  description:
    'Sets/records the drink-window (maturity) years for one wine+vintage: early/peak/late, each a from/until pair. ' +
    'Call whenever the somm wants to set, record, or CORRECT when a specific wine is drinkable. Address the profile ' +
    'either by profile_id (from list_maturity_queue) or by wine_id + vintage (wine_id from search_registry/get_wine/' +
    'drink_window_for) — the wine_id route reaches ALREADY-REVIEWED profiles too, so it is how a published window ' +
    'gets corrected. Absolute years (1900–2200) — except NV vintages, which use RELATIVE year-offsets 0–100 counted ' +
    'from when the owner ACQUIRES the bottle (resolved against each bottle\'s purchase year; 0 = drink right after ' +
    'purchase). Ordering: each until ≥ its from; peak_from ≥ early_from; late_from ≥ peak_from. Marks the profile ' +
    'reviewed. This is SHARED data powering every user\'s recommendations — confirm the values with the somm first. ' +
    'Reversible via undo_last.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    profile_id: objectId.optional().describe('From list_maturity_queue — or address by wine_id + vintage instead'),
    wine_id: objectId.optional().describe('Registry wine id — pass together with vintage when no profile_id is at hand'),
    vintage: z.string().min(1).max(10).optional().describe('The vintage of the profile to address, e.g. "2019" or "NV"'),
    early_from: z.number().int().nullable().optional(),
    early_until: z.number().int().nullable().optional(),
    peak_from: z.number().int().nullable().optional(),
    peak_until: z.number().int().nullable().optional(),
    late_from: z.number().int().nullable().optional(),
    late_until: z.number().int().nullable().optional(),
    somm_notes: z.string().max(2000).optional(),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    // Two address forms (support ticket d49cc924: reviewed profiles were
    // unreachable — nothing returns a profile_id once a pair leaves the
    // pending queue, so a published-but-wrong window could not be corrected
    // over MCP). profile_id wins when both are sent; wine_id+vintage resolves
    // through the (wineDefinition, vintage) unique index, reviewed or not.
    let profile;
    if (args.profile_id) {
      profile = await WineVintageProfile.findById(args.profile_id).populate('wineDefinition', 'name producer');
      if (!profile) return fail('not_found', 'No such maturity profile. Use list_maturity_queue for valid ids.');
    } else if (args.wine_id && args.vintage) {
      // Same canonical vintage string the profiles store: trimmed, 'NV' upper.
      const vintage = /^nv$/i.test(args.vintage.trim()) ? 'NV' : args.vintage.trim();
      profile = await WineVintageProfile.findOne({ wineDefinition: args.wine_id, vintage })
        .populate('wineDefinition', 'name producer');
      if (!profile) {
        return fail('not_found',
          `No maturity profile exists for that wine + vintage "${vintage}". Profiles are seeded when a bottle of the ` +
          'vintage is added — check the vintage against drink_window_for or list_maturity_queue before retrying.');
      }
    } else {
      return fail('invalid_input', 'Address the profile: pass profile_id, or wine_id and vintage together.');
    }

    // Mirror REST validation exactly: NV → relative offsets [0,100], else
    // absolute years [1900,2200] (routes/somm/maturity.js).
    const isNv = profile.vintage === 'NV';
    const [min, max] = isNv ? [0, 100] : [1900, 2200];
    const incoming = {
      earlyFrom: args.early_from, earlyUntil: args.early_until,
      peakFrom: args.peak_from, peakUntil: args.peak_until,
      lateFrom: args.late_from, lateUntil: args.late_until,
    };
    const next = {};
    for (const f of PHASE_FIELDS) {
      const v = incoming[f];
      if (v === undefined) { next[f] = profile[f] ?? null; continue; }
      if (v === null) { next[f] = null; continue; }
      if (v < min || v > max) {
        return fail('invalid_input', `${f}: ${v} out of range (${isNv ? 'NV uses relative offsets 0–100' : 'years 1900–2200'})`);
      }
      next[f] = v;
    }
    // RETAINED values must satisfy the target range too. Profiles that predate
    // the relative-flag derivation (the #908 backfill's re-curation list) hold
    // absolute years under vintage 'NV' — the save below flips relative=true,
    // which would silently reinterpret a carried-forward 2024 as "2024 years
    // after purchase" (audit 2026-08-10). Refuse the partial write and demand
    // a full rewrite instead of laundering the corruption.
    for (const f of PHASE_FIELDS) {
      if (incoming[f] !== undefined) continue;
      const v = next[f];
      if (v != null && (v < min || v > max)) {
        return fail('conflict',
          `${f}=${v} retained from the stored profile is outside the ${isNv ? 'NV offset range 0–100' : 'year range 1900–2200'} — ` +
          'this profile still carries values in the other unit. Rewrite all six phases in this call (pass null to clear a phase).');
      }
    }
    const pairs = [['earlyFrom', 'earlyUntil'], ['peakFrom', 'peakUntil'], ['lateFrom', 'lateUntil']];
    for (const [from, until] of pairs) {
      if (next[from] != null && next[until] != null && next[until] < next[from]) {
        return fail('invalid_input', `${until} cannot be before ${from}`);
      }
    }
    if (next.earlyFrom != null && next.peakFrom != null && next.peakFrom < next.earlyFrom) {
      return fail('invalid_input', 'peak_from cannot be before early_from');
    }
    if (next.peakFrom != null && next.lateFrom != null && next.lateFrom < next.peakFrom) {
      return fail('invalid_input', 'late_from cannot be before peak_from');
    }

    // Snapshot for undo: phases + notes + review state, restored verbatim.
    const prev = {
      ...PHASE_FIELDS.reduce((acc, f) => ((acc[f] = profile[f] ?? null), acc), {}),
      sommNotes: profile.sommNotes ?? null,
      status: profile.status,
      relative: profile.relative,
      setBy: profile.setBy ? String(profile.setBy) : null,
      setAt: profile.setAt || null,
    };

    for (const f of PHASE_FIELDS) profile[f] = next[f] === null ? undefined : next[f];
    if (args.somm_notes !== undefined) profile.sommNotes = args.somm_notes;
    profile.relative = isNv;
    profile.status = 'reviewed';
    profile.setBy = ctx.user.id;
    profile.setAt = new Date();
    await profile.save();

    logAudit(ctx.req, 'somm.maturity.review',
      { type: 'wine', id: profile.wineDefinition?._id || profile.wineDefinition },
      { vintage: profile.vintage, relative: isNv, via: 'mcp' });

    const envelope = {
      summary: `Maturity set for ${profile.wineDefinition?.name || 'wine'} ${profile.vintage} (reviewed)`,
      data: {
        profile_id: profile._id,
        vintage: profile.vintage,
        relative_nv: isNv,
        phases: next,
        somm_notes: profile.sommNotes || null,
        undo: 'undo_last restores the previous values and review state',
      },
    };
    await logAction(ctx, {
      tool: 'set_vintage_maturity',
      action: 'somm_maturity',
      detail: { profileId: String(profile._id), vintage: profile.vintage },
      prev,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'remove_from_maturity_queue',
  title: 'Sommelier: remove a vintage the wine was never released in',
  description:
    'Deletes a wine+vintage pair from the maturity queue WITHOUT setting a drink window, for the case where the wine ' +
    'does not exist in that vintage (a user typed a year the wine was never released in — often while testing — or a ' +
    'purchase year mistaken for a vintage). Use this instead of guessing values: inventing a window poisons shared ' +
    'data. Not a quarantine — the next time anyone adds a bottle of this wine+vintage the pair re-enters the queue ' +
    'like any other wine, so if that vintage becomes real it still gets curated. Refuses a reviewed pair (reset it ' +
    'first). Reversible via undo_last.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    profile_id: objectId.describe('From list_maturity_queue'),
    reason: z.string().max(200).optional()
      .describe('Why, for the audit trail — e.g. "2027 not released; user typed the purchase year".'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const profile = await WineVintageProfile.findById(args.profile_id).populate('wineDefinition', 'name producer');
    if (!profile) return fail('not_found', 'No such maturity profile. Use list_maturity_queue for valid ids.');
    if (profile.status === 'reviewed') {
      return fail('conflict', 'This vintage is already reviewed — reset it to pending before removing it.');
    }

    // Wine+vintage is all the undo needs: a removed row is the auto-seeded
    // pending stub (phases and notes only exist on reviewed rows), so undoing
    // is re-seeding, not restoring field values.
    const prev = {
      wineDefinition: String(profile.wineDefinition?._id || profile.wineDefinition),
      vintage: profile.vintage,
    };
    await WineVintageProfile.deleteOne({ _id: profile._id });

    logAudit(ctx.req, 'somm.maturity.remove',
      { type: 'wine', id: profile.wineDefinition?._id || profile.wineDefinition },
      { vintage: profile.vintage, ...(args.reason ? { reason: args.reason } : {}), via: 'mcp' });

    const envelope = {
      summary: `Removed ${profile.wineDefinition?.name || 'wine'} ${profile.vintage} from the maturity queue — it returns if anyone adds a bottle of that wine+vintage`,
      data: {
        vintage: profile.vintage,
        removed: true,
        undo: 'undo_last puts it back in the queue',
      },
    };
    await logAction(ctx, {
      tool: 'remove_from_maturity_queue',
      action: 'somm_maturity_remove',
      detail: { profileId: String(profile._id), vintage: profile.vintage },
      prev,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'set_wine_profile',
  title: 'Sommelier: write or correct a wine\'s tasting profile, type or grapes',
  description:
    'WRITES or corrects the tasting profile on a registry wine — body, tannin, acidity, sweetness, flavours, food ' +
    'pairings and the prose description — and the wine\'s structural record fields type and grapes (a wrong type ' +
    'changes filtering, serving and storage guidance; use when e.g. a vin jaune is typed "fortified" or a cider ' +
    '"rosé"). Get wine_id from list_maturity_queue, search_registry or get_wine. FIELD-LEVEL: omit a field to leave ' +
    'it alone, pass null to CLEAR it — except type, which can only be corrected, never cleared. Grape values are ' +
    'variety NAMES resolved against the taxonomy (synonyms work: "Shiraz" finds Syrah); an unknown variety is ' +
    'refused, never created. Authoring from nothing is now the NORMAL path, not the exception: records with no ' +
    'region or appellation are deliberately never auto-enriched, so on those the only profile a reader will ever ' +
    'see is the one you write here — and writing it during the maturity pass costs one extra step on research you ' +
    'have already done. A write that sets profile values marks the profile curator-verified, which permanently ' +
    'stops the AI regenerating over it; a write that ONLY clears does NOT verify — the wine stays eligible for ' +
    'enrichment, so clearing fiction you cannot replace is still better than leaving it. This is SHARED data shown ' +
    'to every owner of the wine — confirm the values with the somm first. Reversible via undo_last.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_maturity_queue, search_registry or get_wine'),
    body: z.enum(PROFILE_ENUMS.body).nullable().optional(),
    tannin: z.enum(PROFILE_ENUMS.tannin).nullable().optional(),
    acidity: z.enum(PROFILE_ENUMS.acidity).nullable().optional(),
    sweetness: z.enum(PROFILE_ENUMS.sweetness).nullable().optional(),
    flavors: z.array(z.string().max(40)).max(10).nullable().optional()
      .describe('Concrete aromas, e.g. ["dried fig","walnut"]. Replaces the whole list.'),
    food_pairings: z.array(z.string().max(60)).max(8).nullable().optional()
      .describe('Replaces the whole list.'),
    description: z.string().max(1000).nullable().optional()
      .describe('Plain-text tasting note shown to owners. null clears it.'),
    type: z.enum(WINE_TYPES).optional()
      .describe('Correct the wine\'s structural type. Cannot be cleared — every wine has one.'),
    grapes: z.array(z.string().min(1).max(GRAPE_NAME_MAX)).max(GRAPES_MAX).nullable().optional()
      .describe('Replace the grape list with these variety NAMES (taxonomy-resolved, synonyms ok). null clears the list.'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    // Same validator the REST route uses, so the two surfaces cannot drift.
    // snake_case is the MCP convention; map to the model's camelCase first.
    const patch = {};
    for (const f of ['body', 'tannin', 'acidity', 'sweetness', 'description', 'flavors', 'type', 'grapes']) {
      if (args[f] !== undefined) patch[f] = args[f];
    }
    if (args.food_pairings !== undefined) patch.foodPairings = args.food_pairings;

    const check = validateProfilePatch(patch);
    if (!check.ok) return fail('invalid_input', check.error);

    // Names → taxonomy ids, match-only: an unknown variety fails loudly here
    // rather than minting junk taxonomy every owner then sees.
    let grapeNames = null;
    let grapeSubs = [];
    if (Array.isArray(check.clean.grapes) && check.clean.grapes.length > 0) {
      const resolved = await resolveGrapeIdsStrict(check.clean.grapes);
      if (!resolved.ok) {
        return fail('invalid_input',
          `Not in the grape taxonomy: ${resolved.unmatched.join(', ')}. Synonyms resolve ("Shiraz" finds Syrah) — ` +
          'check the spelling; a genuinely new variety needs an admin taxonomy add first.');
      }
      check.clean.grapes = resolved.ids;
      grapeNames = resolved.names;
      grapeSubs = resolved.substitutions || [];
    } else if (Array.isArray(check.clean.grapes)) {
      grapeNames = [];
    }

    const wine = await WineDefinition.findById(args.wine_id);
    if (!wine) return fail('not_found', 'No such wine. Use search_registry to find it.');

    const prev = snapshotProfile(wine);
    applyProfilePatch(wine, check.clean, ctx.user.id);
    try {
      await wine.save();
    } catch (err) {
      if (err?.name === 'VersionError') return fail('conflict', 'The wine changed mid-write — retry.');
      throw err;
    }
    require('../../services/search').indexWine(wine._id).catch(() => {});
    // Same follow-through as the REST route: the corrected profile must reach
    // Qdrant now, not at the next manual batch run (none is scheduled).
    require('../../services/embeddingJob').reembedActiveVintages(wine._id).catch(() => {});

    // Same audit action string as the REST route — REST and MCP curation must
    // audit identically (see this file's header).
    logAudit(ctx.req, 'somm.wineProfile.update', { type: 'wine', id: wine._id }, {
      wine: `${wine.producer} — ${wine.name}`,
      fields: Object.keys(check.clean),
      previousSource: prev.source,
      via: 'mcp',
    });

    // Say what actually happened to provenance: a pure-clear on an AI profile
    // deliberately does NOT verify (the wine stays enrichment-eligible), and a
    // type/grapes-only write never touches the tasting profile's provenance.
    const profileTouched = Object.keys(check.clean).some((f) => !['type', 'grapes'].includes(f));
    const curatorNow = wine.aiProfile?.source === 'curator';
    const outcome = !profileTouched
      ? 'record fields corrected'
      : curatorNow ? 'now curator-verified' : 'cleared — still eligible for AI enrichment';
    // The write path must SAY when it stores something other than what the
    // curator sent (ticket 2026-08-11: "Tinta Roriz" silently became
    // Tempranillo) — surfaced in the summary, the record, AND the note so no
    // reading depth misses it.
    const subsLine = grapeSubs.length
      ? ` — stored under canonical variety name${grapeSubs.length > 1 ? 's' : ''}: ${grapeSubs.map((s) => `"${s.from}" as ${s.to}`).join(', ')}`
      : '';
    const envelope = {
      summary: `${wine.producer} — ${wine.name} updated (${outcome})${subsLine}`,
      data: {
        wine_id: wine._id,
        updated_fields: Object.keys(check.clean),
        profile: {
          body: wine.aiProfile.body,
          tannin: wine.aiProfile.tannin,
          acidity: wine.aiProfile.acidity,
          sweetness: wine.aiProfile.sweetness,
          flavors: wine.aiProfile.flavors,
          food_pairings: wine.aiProfile.foodPairings,
          description: wine.aiProfile.description,
          source: wine.aiProfile.source,
        },
        record: {
          type: wine.type || null,
          ...(grapeNames !== null ? { grapes: grapeNames } : {}),
          ...(grapeSubs.length ? { grape_substitutions: grapeSubs.map((s) => `${s.from} → ${s.to}`) } : {}),
        },
        note: (profileTouched
          ? (curatorNow
            ? 'The AI enrichment job will no longer overwrite this wine.'
            : 'Cleared without verifying — the AI enrichment job may regenerate this profile.')
          : 'Type/grape corrections do not claim the tasting profile was verified.')
          + (grapeSubs.length
            ? ' Grape names are stored under their canonical variety doc (same variety, canonical display) — see grape_substitutions.'
            : ''),
        undo: 'undo_last restores the previous profile and its provenance',
      },
    };
    await logAction(ctx, {
      tool: 'set_wine_profile',
      action: 'somm_wine_profile',
      detail: { wineId: String(wine._id), fields: Object.keys(check.clean) },
      prev,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'add_grape',
  title: 'Sommelier: add a variety to the grape taxonomy',
  description:
    'Adds a NEW grape variety to the shared taxonomy — the unblock for set_wine_profile/propose_wine_correction ' +
    'failing with "not in the grape taxonomy". Until 2026-08-22 this needed an admin and a support ticket (Norton, ' +
    'St. Pepin, Souzão, Vidal and three more were all filed that way in one week); wine data is somm-owned now, and ' +
    'taxonomy is wine data. Match-first: if the name or any synonym already resolves to an existing variety, ' +
    'nothing is created and the tool tells you what it resolves to — so calling it "just in case" is safe. Include ' +
    'the synonyms owners actually write (accents, hyphens, Cynthiana-for-Norton) — they are what the resolver ' +
    'matches label text against. colour follows the registry rule: the colour of the BERRY (Red/White), null only ' +
    'for genuine edge cases. Adds are audited and attributed to you.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    name: z.string().min(1).max(60).describe('Canonical variety name, e.g. "St. Pepin"'),
    colour: z.enum(['Red', 'White']).nullable().describe('Berry colour. Red covers rosé-capable reds; null only for a genuine edge case'),
    synonyms: z.array(z.string().min(1).max(60)).max(8).optional()
      .describe('Alternative spellings and true synonyms, e.g. ["St-Pepin","Saint Pepin"] — what the resolver matches against'),
    origin: z.string().max(80).optional().describe('Country or region of origin, e.g. "Portugal"'),
    description: z.string().max(500).optional().describe('One or two plain-text sentences: what the variety is and where it matters'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const Grape = require('../../models/Grape');

    const name = sanitizeTaxonomyName(args.name);
    if (!name) return fail('invalid_input', 'name is empty after sanitising');
    const synonyms = [...new Set((args.synonyms || []).map((s) => sanitizeTaxonomyName(s)).filter(Boolean))]
      .filter((s) => normalizeString(s) !== normalizeString(name));

    // Every string this row would claim — canonical name and all synonyms —
    // must be unclaimed. Two varieties answering to one string would make
    // resolveGrapeIdsStrict ambiguous for every later profile write.
    const claims = [name, ...synonyms].map((s) => normalizeString(s));
    const taken = await Grape.findOne({
      $or: [{ normalizedName: { $in: claims } }, { normalizedSynonyms: { $in: claims } }],
    }).select('name synonyms').lean();
    if (taken) {
      return fail('conflict',
        `Already in the taxonomy: "${taken.name}"${taken.synonyms?.length ? ` (synonyms: ${taken.synonyms.join(', ')})` : ''} ` +
        'claims one of these names. Use that variety, or propose a rename instead of a second row.');
    }

    const grape = new Grape({
      name,
      normalizedName: normalizeString(name),
      color: args.colour ?? null,
      synonyms,
      origin: args.origin ? String(args.origin).trim() : null,
      description: args.description ? stripHtml(String(args.description)).trim() : '',
      createdBy: ctx.user.id,
    });
    await grape.save();

    logAudit(ctx.req, 'somm.taxonomy.create',
      { type: 'grape', id: grape._id }, { name: grape.name, colour: grape.color, synonyms });

    const envelope = {
      summary: `Added "${grape.name}" (${grape.color || 'no colour'}) to the grape taxonomy${synonyms.length ? ` with ${synonyms.length} synonym(s)` : ''}`,
      data: {
        grape_id: String(grape._id),
        name: grape.name,
        colour: grape.color,
        synonyms,
        note: 'Resolves immediately — re-run the set_wine_profile or correction that failed on it.',
      },
    };
    await logAction(ctx, {
      tool: 'add_grape',
      action: 'somm_grape',
      detail: { grapeId: String(grape._id), name: grape.name },
      prev: null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'edit_grape',
  title: 'Sommelier: correct an existing grape — colour, synonyms, regional names',
  description:
    'Edits a variety ALREADY in the taxonomy. add_grape only creates, which left no route to fix a row that ' +
    'arrived incomplete — a curator could see the hole and not fill it. ' +
    'COLOUR IS THE ONE THAT MATTERS MOST. A grape with no colour cannot take part in the colour-conflict check ' +
    'at all: wines built on it are not failing that check, they are never evaluated, so the queue reports zero ' +
    'and reads as clean. Filling seven null colours on 2026-08-23 immediately surfaced a wine typed red whose ' +
    'only grape was white. If you see a variety with no colour, that is a silent hole in a live validation rule. ' +
    'REGIONAL NAMES render the label a drinker in that country would actually see — Gouveio on a Douro wine ' +
    'rather than Godello, Durif in Australia rather than Petite Sirah — while storage keeps ONE canonical ' +
    'variety. Pass region as well as country where a variety has several (Carignan is Mazuelo in Rioja and ' +
    'Carignano in Sardinia), and add the same string as a synonym so label text and imports resolve INBOUND too, ' +
    'not only render outbound. Synonyms and regional names are additive; nothing is ever removed.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    grape: z.string().min(1).max(60).describe('The variety to edit, by canonical name or an existing synonym'),
    colour: z.enum(['Red', 'White']).optional()
      .describe('Berry colour. Only settable while it is unset — changing an established colour is a merge-shaped decision, so it is refused.'),
    add_synonyms: z.array(z.string().min(1).max(60)).max(8).optional()
      .describe('Alternative spellings to resolve INBOUND. Additive.'),
    regional_name: z.string().min(1).max(60).optional()
      .describe('The label form used in one country, e.g. "Durif". Requires country.'),
    country: z.string().min(1).max(60).optional().describe('Country the regional_name applies in, by name, e.g. "Australia"'),
    region: z.string().min(1).max(60).optional()
      .describe('Narrow the regional_name to one region, e.g. "Rioja" for Mazuelo. Omit for country-wide.'),
    origin: z.string().max(80).optional(),
    description: z.string().max(500).optional(),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const Grape = require('../../models/Grape');
    const Country = require('../../models/Country');
    const Region = require('../../models/Region');

    const key = normalizeString(args.grape);
    const grape = await Grape.findOne({ $or: [{ normalizedName: key }, { normalizedSynonyms: key }] });
    if (!grape) return fail('not_found', `No variety resolves from "${args.grape}" — add_grape creates a new one.`);

    const before = { color: grape.color, synonyms: [...(grape.synonyms || [])], regionalNames: (grape.regionalNames || []).length };
    const applied = [];

    if (args.colour !== undefined) {
      // An established colour is load-bearing: the conflict check and the
      // registry's colour rule both read it, and flipping one would re-judge
      // every wine built on the variety. Setting an UNSET one is the fix this
      // tool exists for; overwriting is a different, larger decision.
      if (grape.color && grape.color !== args.colour) {
        return fail('conflict',
          `"${grape.name}" is already ${grape.color}. Changing an established colour re-judges every wine built on it — ` +
          'file a support ticket with the evidence rather than flipping it here.');
      }
      if (!grape.color) { grape.color = args.colour; applied.push(`colour ${args.colour}`); }
    }

    if (Array.isArray(args.add_synonyms) && args.add_synonyms.length) {
      const claims = args.add_synonyms.map((s) => sanitizeTaxonomyName(s)).filter(Boolean);
      for (const s of claims) {
        const n = normalizeString(s);
        // A synonym another variety already answers to would make the
        // resolver ambiguous for every later write.
        const taken = await Grape.findOne({
          _id: { $ne: grape._id },
          $or: [{ normalizedName: n }, { normalizedSynonyms: n }],
        }).select('name').lean();
        if (taken) return fail('conflict', `"${s}" already resolves to "${taken.name}" — one string cannot mean two varieties.`);
        if (n === normalizeString(grape.name)) continue;
        if (!(grape.synonyms || []).some((x) => normalizeString(x) === n)) {
          grape.synonyms.push(s);
          applied.push(`synonym ${s}`);
        }
      }
    }

    if (args.regional_name) {
      if (!args.country) return fail('invalid_input', 'regional_name needs a country — a label form is only true somewhere.');
      const country = await Country.findOne({ normalizedName: normalizeString(args.country) }).select('_id name').lean();
      if (!country) return fail('not_found', `Unknown country "${args.country}".`);
      let regionDoc = null;
      if (args.region) {
        regionDoc = await Region.findOne({ country: country._id, normalizedName: normalizeString(args.region) }).select('_id name').lean();
        if (!regionDoc) return fail('not_found', `No region "${args.region}" in ${country.name}.`);
      }
      const rn = sanitizeTaxonomyName(args.regional_name);
      const dup = (grape.regionalNames || []).some((x) =>
        String(x.country) === String(country._id) &&
        String(x.region || '') === String(regionDoc ? regionDoc._id : '') &&
        normalizeString(x.name) === normalizeString(rn));
      if (!dup) {
        grape.regionalNames.push({ country: country._id, region: regionDoc ? regionDoc._id : null, name: rn });
        applied.push(`regional name ${rn} (${country.name}${regionDoc ? ' / ' + regionDoc.name : ''})`);
      }
    }

    if (args.origin && !grape.origin) { grape.origin = String(args.origin).trim(); applied.push('origin'); }
    if (args.description && !grape.description) { grape.description = stripHtml(String(args.description)).trim(); applied.push('description'); }

    if (applied.length === 0) return ok(`Nothing to change on "${grape.name}" — every value given is already set.`, { grape: grape.name });
    await grape.save();

    logAudit(ctx.req, 'somm.taxonomy.update', { type: 'grape', id: grape._id },
      { name: grape.name, applied, from: before });

    const envelope = {
      summary: `Updated "${grape.name}": ${applied.join(', ')}`,
      data: {
        grape_id: String(grape._id),
        name: grape.name,
        colour: grape.color,
        synonyms: grape.synonyms,
        applied,
        note: args.colour
          ? 'Wines built on this variety are now visible to the colour-conflict check — worth running list_colour_conflicts.'
          : 'Regional names render on owner-facing surfaces; the stored variety is unchanged.',
      },
    };
    await logAction(ctx, {
      tool: 'edit_grape',
      action: 'somm_grape',
      detail: { grapeId: String(grape._id), name: grape.name, applied },
      prev: before,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'list_price_tracking_requests',
  title: 'Sommelier: list the price-request queue',
  description:
    'Lists wine+vintage pairs users have asked to have price-tracked, where no price exists yet or the latest is ' +
    'older than 3 months. Most-requested first. Call when the somm asks "any price requests waiting?"; fulfil with ' +
    'set_vintage_price, or decline unsuitable ones (no secondary market) with reject_price_request. Declined pairs ' +
    'no longer appear here.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(20),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
    const requests = await PriceTrackingRequest.find({})
      .populate({ path: 'wineDefinition', select: 'name producer type', populate: ['country', 'region'] })
      .lean();
    let alive = requests.filter((r) => r.wineDefinition);

    // Curator-declined pairs never surface: reject_price_request deletes the
    // request AND records a PriceTrackingSkip, so this filter is normally a
    // no-op — it exists so a re-request that raced a decline can't resurrect
    // the row while the skip stands (mirrors routes/somm/prices.js GET /queue).
    if (alive.length) {
      const skips = await PriceTrackingSkip.find({ wineDefinition: { $in: alive.map((r) => r.wineDefinition._id) } })
        .select('wineDefinition vintage').lean();
      if (skips.length) {
        const skipped = new Set(skips.map((s) => `${s.wineDefinition}:${s.vintage}`));
        alive = alive.filter((r) => !skipped.has(`${r.wineDefinition._id}:${r.vintage}`));
      }
    }

    // Actionable = no price yet, or latest snapshot stale (>90d) — mirrors
    // routes/somm/prices.js GET /queue.
    const latestByPair = new Map();
    if (alive.length) {
      const rows = await WineVintagePrice.aggregate([
        { $match: { wineDefinition: { $in: alive.map((r) => r.wineDefinition._id) } } },
        { $sort: { setAt: 1 } },
        { $group: { _id: { w: '$wineDefinition', v: '$vintage' }, price: { $last: '$price' }, currency: { $last: '$currency' }, setAt: { $last: '$setAt' } } },
      ]);
      for (const row of rows) latestByPair.set(`${row._id.w}:${row._id.v}`, row);
    }
    const now = Date.now();
    const actionable = alive
      .map((r) => ({ r, latest: latestByPair.get(`${r.wineDefinition._id}:${r.vintage}`) || null }))
      .filter(({ latest }) => !latest || now - new Date(latest.setAt).getTime() > PRICE_STALE_MS)
      .sort((a, b) => (b.r.requesters?.length || 0) - (a.r.requesters?.length || 0)
        || new Date(a.r.firstRequestedAt || 0) - new Date(b.r.firstRequestedAt || 0));

    const data = actionable.slice(0, limit).map(({ r, latest }) => ({
      request_id: r._id,
      wine: wineLite(r.wineDefinition),
      vintage: r.vintage,
      requester_count: r.requesters?.length || 0,
      first_requested_at: r.firstRequestedAt || null,
      latest_price: latest ? { price: latest.price, currency: latest.currency, set_at: latest.setAt } : null,
    }));
    return ok(`${actionable.length} actionable price request(s)${actionable.length > limit ? ` (showing ${limit})` : ''}`, data);
  },
});

registerTool({
  name: 'set_vintage_price',
  title: 'Sommelier: add a price valuation for a vintage',
  description:
    'Records a new price snapshot for one wine+vintage (price history accumulates — this never overwrites). ' +
    'Requesters are notified, and the pair leaves the price queue until the snapshot goes stale. This is SHARED ' +
    'valuation data — confirm price, currency and source with the somm first. Reversible via undo_last (removes the ' +
    'snapshot).',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId,
    vintage: z.string().min(1).max(10),
    price: z.number().min(0),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Default USD'),
    source: z.string().max(100).optional().describe('e.g. auction, retail, Systembolaget'),
    somm_notes: z.string().max(2000).optional(),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const currency = String(args.currency || 'USD').toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return fail('invalid_input', `Unsupported currency ${currency}. Supported: ${SUPPORTED_CURRENCIES.join(', ')}`);
    }
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');
    const wine = await WineDefinition.findById(args.wine_id).select('name producer');
    if (!wine) return fail('not_found', 'No registry wine with that id.');

    const entry = new WineVintagePrice({
      wineDefinition: wine._id,
      vintage: String(args.vintage).trim(),
      price: args.price,
      currency,
      source: args.source?.trim() || undefined,
      sommNotes: args.somm_notes?.trim() || undefined,
      setBy: ctx.user.id,
    });
    await entry.save();

    require('../../utils/exchangeRates').getOrCreateDailySnapshot().catch(() => {});
    // Notify requesters exactly like REST (best-effort).
    PriceTrackingRequest.findOne({ wineDefinition: wine._id, vintage: entry.vintage }).lean()
      .then((reqDoc) => {
        if (!reqDoc?.requesters?.length) return;
        const { createNotification } = require('../../services/notifications');
        for (const { user } of reqDoc.requesters) {
          createNotification(user, 'price_tracked', 'Price added',
            `${wine.name} ${entry.vintage}: ${entry.price} ${entry.currency}`,
            '/somm/prices', 'community').catch(() => {}); // link parity with REST
        }
      }).catch(() => {});

    logAudit(ctx.req, 'somm.price.add',
      { type: 'wine', id: wine._id },
      { vintage: entry.vintage, price: entry.price, currency: entry.currency, via: 'mcp' });

    const envelope = {
      summary: `Price recorded: ${wine.name} ${entry.vintage} = ${entry.price} ${entry.currency}`,
      data: {
        price_entry_id: entry._id,
        wine_id: wine._id,
        vintage: entry.vintage,
        price: entry.price,
        currency: entry.currency,
        undo: 'undo_last removes this snapshot',
      },
    };
    await logAction(ctx, {
      tool: 'set_vintage_price',
      action: 'somm_price',
      detail: { entryId: String(entry._id), wineId: String(wine._id), vintage: entry.vintage },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// Mirror routes/somm/prices.js POST /requests/:id/decline — same bounds, same
// audit action string, same requester notification wording.
const DECLINE_REASON_MIN = 5;
const DECLINE_REASON_MAX = 500;

registerTool({
  name: 'reject_price_request',
  title: 'Sommelier: decline a price-tracking request',
  description:
    'Declines one price-tracking request WITH a required reason — for pairs that fail the secondary-market test ' +
    '(everyday retail wines with no auction/resale data) or are otherwise not worth tracking. Every requester is ' +
    'notified with the reason VERBATIM — confirm the wording with the somm first. The pair leaves the queue and ' +
    'future tracking requests for the same wine+vintage are refused while the decline stands. Get request_id from ' +
    'list_price_tracking_requests. To fulfil instead, use set_vintage_price. Reversible via undo_last (restores the ' +
    'request and lifts the suppression; the notifications already sent stand).',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    request_id: objectId.describe('From list_price_tracking_requests'),
    reason: z.string().min(DECLINE_REASON_MIN).max(DECLINE_REASON_MAX)
      .describe('Why tracking is declined — sent verbatim to the requester(s), e.g. "Everyday retail wine with no secondary market; prices would not be meaningful."'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    // Same hygiene as the REST route: the reason reaches the skip document and
    // the requester notifications — plain text only, bounded even after strip.
    const reason = stripHtml(typeof args.reason === 'string' ? args.reason : '');
    if (!reason || reason.length < DECLINE_REASON_MIN) {
      return fail('invalid_input', `reason must be at least ${DECLINE_REASON_MIN} characters of plain text (HTML is stripped) — the requester(s) read it.`);
    }
    if (reason.length > DECLINE_REASON_MAX) {
      return fail('invalid_input', `reason must be at most ${DECLINE_REASON_MAX} characters.`);
    }

    const request = await PriceTrackingRequest.findById(args.request_id);
    if (!request) {
      return fail('not_found', 'No such price-tracking request — it may already be fulfilled or declined. Use list_price_tracking_requests for valid ids.');
    }
    const wine = await WineDefinition.findById(request.wineDefinition).select('name producer');

    // Suppression: the skip is what keeps the pair from re-entering the queue
    // via future user requests (routes/bottles.js refuses on it). $setOnInsert
    // keeps the FIRST decline's reason if two curators race; updatedExisting
    // tells the undo whether THIS call created the suppression (only then may
    // an undo lift it).
    const skipRes = await PriceTrackingSkip.findOneAndUpdate(
      { wineDefinition: request.wineDefinition, vintage: request.vintage },
      { $setOnInsert: {
        wineDefinition: request.wineDefinition,
        vintage: request.vintage,
        reason,
        skippedBy: ctx.user.id,
        skippedAt: new Date(),
      } },
      { upsert: true, new: false, includeResultMetadata: true }
    );
    const skipCreated = !skipRes?.lastErrorObject?.updatedExisting;

    // Everything the undo needs to put the request back verbatim.
    const prev = {
      wineDefinition: String(request.wineDefinition),
      vintage: request.vintage,
      requesters: (request.requesters || []).map((r) => ({ user: String(r.user), requestedAt: r.requestedAt, note: r.note })),
      firstRequestedAt: request.firstRequestedAt || null,
      lastRequestedAt: request.lastRequestedAt || null,
      skipCreated,
    };
    await PriceTrackingRequest.deleteOne({ _id: request._id });

    // Notify every requester with the verbatim reason — best-effort, exactly
    // like set_vintage_price: delivery never blocks the decline.
    const wineLabel = wine ? [wine.producer, wine.name].filter(Boolean).join(' — ') : 'this wine';
    {
      const { createNotification } = require('../../services/notifications');
      const title = 'Price tracking request declined';
      const body = `Your request to track market price for ${wineLabel} ${request.vintage} was declined by a sommelier. Reason: ${reason}`;
      for (const r of prev.requesters) {
        createNotification(r.user, 'price_tracking_declined', title, body, null, 'community').catch(() => {});
      }
    }

    // Same audit action string as the REST decline route — REST and MCP
    // curation must audit identically (see this file's header).
    logAudit(ctx.req, 'somm.price.decline',
      { type: 'wine', id: request.wineDefinition },
      { vintage: request.vintage, reason, requesters: prev.requesters.length, via: 'mcp' });

    const envelope = {
      summary: `Declined price tracking for ${wine?.name || 'wine'} ${request.vintage} — ${prev.requesters.length} requester(s) notified with the reason`,
      data: {
        request_id: String(request._id),
        wine_id: String(request.wineDefinition),
        vintage: request.vintage,
        reason,
        requesters_notified: prev.requesters.length,
        suppressed: true,
        note: 'Future tracking requests for this wine+vintage are refused while the decline stands.',
        undo: 'undo_last restores the request and lifts the suppression',
      },
    };
    await logAction(ctx, {
      tool: 'reject_price_request',
      action: 'somm_price_decline',
      detail: { requestId: String(request._id), wineId: String(request.wineDefinition), vintage: request.vintage, reason },
      prev,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// The weekly spot-check (ticket 6a8464ea phase 3): regional-prior
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
      // Pilot 2026-08-19: judge search-assisted rows apart — their error rate
      // vs the un-searched population is the pilot's go/no-go number.
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
    '(field_correction | merge | non_wine), wine_id, or status (pending | approved | rejected — decided rows carry ' +
    'the decision and any reject reason). Note: MERGE proposals are filed over MCP but DECIDED in Admin → Wines on ' +
    'the web — deliberate, a wine merge moves bottles and rewrites references (same stance as taxonomy merge).',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    kind: z.enum(['field_correction', 'merge', 'non_wine']).optional(),
    wine_id: z.string().optional().describe('Only proposals for this registry wine'),
    status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
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
    const ProfileAuditSample = require('../../models/ProfileAuditSample');
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

// ── The held-profile review queue over MCP (somm ticket 2026-08-18) ─────────
// The publication gate holds profiles; judging those holds lived only in the
// web admin queue, so ~230 rows of judgement work could not be done over MCP
// at all. One list + one decision verb, and every decision path leaves the
// row OUT of the queue by construction — the 57 unstamped rows from the
// 08-17 bulk release exist precisely because a release path skipped the
// profileReviewedAt stamp, and this surface must not recreate that bug.

const HELD_LIST_CAP = 500;
// What still needs judging — and the two states answer DIFFERENT questions, so
// they cannot share a marker (somm ticket 6a85f5e8):
//
//   HELD          — "is this generated profile publishable?" profileReviewedAt
//                   is the right signal: any human write to the profile
//                   answers it, which is why applyProfilePatch stamps it.
//   PUBLISHED     — "is the producer field real?" A tasting-profile write does
//   SUSPECT         NOT answer that, yet it stamped profileReviewedAt and the
//                   row vanished from this queue undecided. Only an explicit
//                   uphold/confirm closes it now.
const OUTSTANDING_EXPR = {
  $cond: [
    { $ne: ['$aiProfile.heldAt', null] },
    {
      $or: [
        { $eq: ['$profileReviewedAt', null] },
        { $lt: ['$profileReviewedAt', '$aiProfile.generatedAt'] },
      ],
    },
    { $eq: [{ $ifNull: ['$aiProfile.suspectDecision', null] }, null] },
  ],
};

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
    'suspect (the 08-17 batch) — same judgement work, different state. Owner-count rides on every row and the list ' +
    'is impact-first (owners desc, then confidence asc). Judge each with review_held_profile; rows you have decided ' +
    'disappear from this list. ' +
    'SINCE 2026-08-22 this is also the INTAKE queue: automatic AI enrichment is off (wine data is somm-owned), so ' +
    'every new registry wine appears here as state "unprofiled" — no flags, no confidence, just a wine awaiting its ' +
    'first profile. Write it with set_wine_profile (type/grape fixes ride the same call); identity gaps go through ' +
    'propose_wine_correction as usual. state:"unprofiled" lists only these.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    held_reason: z.string().max(40).optional().describe('Filter the HELD set to one reason (e.g. "taxonomy_conflict"); "legacy" = rows with no recorded reason'),
    state: z.enum(['held', 'published_suspect', 'unprofiled']).optional()
      .describe('One state only. "unprofiled" = wines with NO profile at all — since automatic AI enrichment was turned off (2026-08-22, somm-owned data) every new wine lands here and set_wine_profile is how it leaves. Omit for all states.'),
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
    // be held or suspect); unprofiled is the 2026-08-22 intake queue:
    // automatic AI enrichment is OFF (somm-owned data), so a new wine arrives
    // with NO profile at all and this list is the only place the somm can see
    // it. `description: null` keeps the 188 curator rows that predate the
    // generatedAt stamp out of the unprofiled state — a wine with a written
    // description is not awaiting a profile.
    const wantState = (s) => args.state === undefined || args.state === s;
    const or = [];
    if (wantState('held')) {
      or.push({ 'aiProfile.heldAt': { $ne: null }, 'aiProfile.generatedAt': { $ne: null } });
    }
    // An explicit state ask implies the include flag — asking for suspects
    // and getting nothing because a second switch was off would be a trap.
    // counts_only implies it too (somm ticket 6a8ffaa1): the listing default
    // exists to keep suspects out of a curator's held-row PAGING, but a count
    // has no paging to protect — carrying the default into it reported
    // published_suspect as a hard 0 (not "uncounted") and under-sized the
    // backlog by three quarters. A count counts every state.
    if (((args.include_published_suspects || args.counts_only) && wantState('published_suspect')) || args.state === 'published_suspect') {
      or.push({ 'aiProfile.heldAt': null, 'aiProfile.generatedAt': { $ne: null }, 'aiProfile.producerSuspect': true, 'aiProfile.description': { $ne: null } });
    }
    if (wantState('unprofiled')) {
      // Mongo form of hasProfileContent — keep the three fields in step with it.
      or.push({ 'aiProfile.generatedAt': null, 'aiProfile.description': null, 'aiProfile.body': null });
    }
    const match = {
      nonWine: { $ne: true }, pendingIdentity: { $ne: true },
      $or: or,
      $expr: OUTSTANDING_EXPR, // a decided row (reviewedAt >= generatedAt) is done — never re-listed
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
    // could not settle this row and asked the person holding the bottle
    // (somm 6a872b98: a held profile was released over the top of an inquiry
    // asking whether that very label reads Hunter Valley or Lodi). Surfacing
    // it here is the cheap half of the fix — the expensive half would be
    // blocking the verbs, and blocking is wrong: the curator may have new
    // evidence the inquiry was waiting for.
    const WineOwnerInquiry = require('../../models/WineOwnerInquiry');
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
        // Region carries the judgement a country cannot (somm ticket
        // 6a84c8e8: Hunter Valley vs "Australia") — and note: regeneration
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
        // Pilot 2026-08-19: a web-search retry already failed on this row —
        // releasing it without curator facts would just re-hold.
        ...(w.aiProfile?.searchUsed === true ? { search_assisted: true } : {}),
        // A previous curator already escalated this row to its owner; deciding
        // over the top of that discards the escalation (somm 6a872b98).
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
    'row simply stays in the queue for another try. decision "confirm": the CURRENT state is correct — a held row ' +
    'stays held (its owner keeps seeing "Not yet assessed"), a published_suspect row stays published WITH THE ' +
    'SUSPECT FLAG CLEARED (a human adjudicated the doubt away), and producerUnknown clears too when set — confirm ' +
    'also works on a published row whose ONLY doubt flag is producerUnknown ("I have placed this producer"; the ' +
    'route a documented estate needed once its profile was fixed but the flag had no verb). decision "uphold" ' +
    '(published_suspect rows only): ' +
    'the flag is CORRECT — the producer value really is a brand/style/non-winery — so the row stays published, ' +
    'KEEPS the flag and the owner-visible caveat, and leaves the queue as the registry\'s honest residue; ' +
    'upheld-count is the true cannot-identify number the scaling review reads. decision "reject" (HELD rows only): ' +
    'this generation is garbage — the profile clears entirely and the wine returns to the enrichment pool. Every ' +
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

    // One wine, one decision — shared by the single and batch paths so the
    // semantics (and the stamp rule) cannot fork.
    const decideOne = async (id) => {
      const wine = await WineDefinition.findById(id)
        .select('name producer aiProfile.heldAt aiProfile.heldReason aiProfile.producerSuspect aiProfile.producerUnknown aiProfile.description aiProfile.generatedAt aiProfile.source');
      if (!wine) return { wine_id: id, error: 'not_found' };
      const ap = wine.aiProfile || {};
      const held = !!ap.heldAt;
      const flaggedPublished = !held && ap.producerSuspect === true && !!ap.description;
      // producerUnknown-only rows are confirmable too (somm 6a86dad6: a
      // documented 180 ha estate carried the flag with no verb able to clear
      // it — set_wine_profile writes the profile, not the doubt fields).
      const unknownOnly = !held && !flaggedPublished && ap.producerUnknown === true;
      if (!held && !flaggedPublished && !(unknownOnly && args.decision === 'confirm')) {
        return { wine_id: id, error: 'nothing_to_review' };
      }
      const label = `${wine.name} — ${wine.producer}`;

      if (args.decision === 'release') {
        if (!held) return { wine_id: id, error: 'already_published — use confirm, or set_wine_profile to correct' };
        const { releaseHeldProfile } = require('../../services/enrichmentJob');
        const published = await releaseHeldProfile(wine._id, { context });
        if (!published) return { wine_id: id, error: 'generation_failed — row stays queued; retry or set_wine_profile' };
        // releaseHeldProfile stamps profileReviewedAt INSIDE its success path —
        // the stamp-on-release rule the 57 unstamped rows exist to teach.
        logAudit(ctx.req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
          { name: wine.name, producer: wine.producer, heldRelease: true, decision: 'release', reason, withContext: !!context, via: 'mcp' });
        return { wine_id: wine._id, label, decision: 'release', published: true };
      }

      if (args.decision === 'confirm') {
        const now = new Date();
        const set = { profileReviewedAt: now };
        // Confirming a PUBLISHED suspect row means a human adjudicated the
        // doubt and kept the row — so the owner-visible caveat must go
        // (somm ticket 6a84c8dc: five documented-domaine rows carried a
        // false "cannot be verified" disclaimer even after review).
        if (!held) {
          if (flaggedPublished) {
            set['aiProfile.producerSuspect'] = false;
            // Record the verdict, not just its side effect. The flag going false
            // already removes the row from the queue, but the decision is worth
            // counting on its own — and it keeps confirm and uphold symmetrical.
            set['aiProfile.suspectDecision'] = 'confirmed';
            set['aiProfile.suspectDecidedAt'] = now;
          }
          // confirm also clears producerUnknown when set: the curator is
          // saying "I have placed this producer", which is that flag's exact
          // negation (somm 6a86dad6 — Haut-Marin). No suspectDecision stamp
          // on an unknown-only row: that field is the verdict on
          // producerSuspect, and ONLY that (6a85f5e8).
          if (ap.producerUnknown === true) set['aiProfile.producerUnknown'] = false;

          // …and the NOTE goes with the flag it explains (somm ticket
          // 6a882f3e). It used to be kept "for curator context", and that was
          // backwards: once a human has adjudicated the doubt, the model's
          // account of the doubt has no remaining audience, and where the note
          // asserted something false it outlived the flag that qualified it.
          //
          // Their worked example: Donnafugata's "Isolano" — the estate's own
          // Etna Bianco — sat confirmed while its note still read "the true
          // producing estate is unclear to me". No curator lever existed to
          // correct that: set_wine_profile does not expose the field and
          // `release` is held-rows-only, which is the wrong population.
          //
          // Scoped to a flag actually clearing. A confirm on a HELD row keeps
          // the row held, so the doubt is unresolved and the note is still
          // live context — clearing there would delete a caveat that still
          // applies. The note is copied into the audit detail below rather
          // than dropped silently: it is the record of what the model claimed,
          // and an admin asking "why was this ever flagged?" deserves an
          // answer after the fact.
          if ((flaggedPublished || ap.producerUnknown === true) && ap.producerNote) {
            set['aiProfile.producerNote'] = null;
          }
        }
        await WineDefinition.updateOne({ _id: wine._id }, { $set: set });
        const state = held ? 'held' : (flaggedPublished ? 'published_suspect' : 'published_unknown');
        const noteCleared = set['aiProfile.producerNote'] === null ? ap.producerNote : null;
        const cleared = {
          ...(flaggedPublished ? { suspectCleared: true } : {}),
          ...(!held && ap.producerUnknown === true ? { unknownCleared: true } : {}),
        };
        logAudit(ctx.req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
          {
            name: wine.name, producer: wine.producer, decision: 'confirm', state, ...cleared,
            // The cleared note, preserved where it can still be read. Bounded:
            // an audit detail is not a place to store an essay.
            ...(noteCleared ? { clearedProducerNote: String(noteCleared).slice(0, 500) } : {}),
            reason, via: 'mcp',
          });
        return {
          wine_id: wine._id, label, decision: 'confirm', state,
          ...(cleared.suspectCleared ? { suspect_cleared: true } : {}),
          ...(cleared.unknownCleared ? { unknown_cleared: true } : {}),
          // Told, not silent: the curator should know the caveat went with the
          // flag, because they can no longer see it to check.
          ...(noteCleared ? { producer_note_cleared: true } : {}),
          reviewed_at: now,
        };
      }

      if (args.decision === 'uphold') {
        // Somm ticket 6a856e97 (2026-08-19): the flag is CORRECT and the only
        // queue-clearing verb used to be the one that damaged the data
        // (confirm clears the flag). Uphold keeps flag + caveat + published
        // state, stamps reviewed, and the row leaves the queue as honest
        // residue — upheld-count is the true cannot-identify number.
        if (held) return { wine_id: id, error: 'uphold_is_published_only — for a held row whose flag is right, confirm keeps it held' };
        const now = new Date();
        // suspectDecision is what closes the row now; profileReviewedAt rides
        // along because it still means "a human looked" for the other queues.
        // The split exists because a curator profile write also stamps
        // profileReviewedAt, and that silently closed 23 rows nobody judged.
        await WineDefinition.updateOne({ _id: wine._id }, {
          $set: {
            profileReviewedAt: now,
            'aiProfile.suspectDecision': 'upheld',
            'aiProfile.suspectDecidedAt': now,
          },
        });
        logAudit(ctx.req, 'admin.wine.profileReviewed', { type: 'wine', id: wine._id },
          { name: wine.name, producer: wine.producer, decision: 'uphold', suspectKept: true, reason, via: 'mcp' });
        return { wine_id: wine._id, label, decision: 'uphold', suspect_kept: true, reviewed_at: now };
      }

      // reject — held rows only: nothing published means nothing embedded, so
      // a full clear needs no vector cleanup. A published row wanting removal
      // is a different operation (set_wine_profile, or an identity fix).
      if (!held) return { wine_id: id, error: 'reject_is_held_only — for a published profile, set_wine_profile, confirm (clears the flag) or uphold (keeps it)' };
      const now = new Date();
      await WineDefinition.updateOne(
        { _id: wine._id },
        {
          $set: {
            aiProfile: {
              body: null, tannin: null, acidity: null, sweetness: null,
              flavors: [], foodPairings: [], description: null,
              confidence: null, producerSuspect: false, producerUnknown: false,
              producerNote: null, model: null, source: 'ai',
              generatedAt: null, heldAt: null, heldReason: null,
            },
            updatedAt: now,
          },
        }
      );
      logAudit(ctx.req, 'somm.profile.rejectHeld', { type: 'wine', id: wine._id },
        { name: wine.name, producer: wine.producer, previousReason: ap.heldReason || null, reason, via: 'mcp' });
      return { wine_id: wine._id, label, decision: 'reject', requeued_for_enrichment: true };
    };

    if (!args.wine_ids) {
      const r = await decideOne(ids[0]);
      if (r.error === 'not_found') return fail('not_found', 'No registry wine with that id.');
      if (r.error === 'nothing_to_review') return fail('invalid_input', 'This wine has no held or suspect-flagged profile to review — list_held_profiles shows the queue.');
      if (r.error) return fail(r.error.startsWith('generation_failed') ? 'unavailable' : 'invalid_input', `${r.error} (${ids[0]})`);
      const msg = r.decision === 'release'
        ? `Released and published the held profile for ${r.label} (regenerated under the human override${context ? ', with curator context' : ''}; review stamped).`
        : r.decision === 'confirm'
          ? (r.state === 'held'
            ? `Confirmed the hold on ${r.label} — it stays unpublished (owners see "Not yet assessed") and leaves the queue.`
            : `Confirmed ${r.label} as published — the suspect flag is CLEARED (a human adjudicated the doubt); producer_note stays for context.`)
          : r.decision === 'uphold'
            ? `Upheld the flag on ${r.label} — stays published WITH the caveat, review stamped; the row is now honest residue, not queue.`
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
    const ProfileAuditSample = require('../../models/ProfileAuditSample');
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

// Correction proposals — the human-gated tier of registry curation. Direct
// somm writes cover type/grapes/tasting profile (set_wine_profile, recoverable
// + undoable); IDENTITY fields drive dedup keys, URLs and every owner's
// display, and curator assertions on producer/name have been confidently wrong
// (5 overturned by web-verification 2026-08-10) — so those go through a
// proposal an admin diffs and applies (routes/admin/wineProposals.js), with
// the curator's research preserved as structured data instead of a prose
// ticket the admin re-types.
const PROPOSAL_KINDS = ['field_correction', 'merge', 'non_wine'];
// The plain-STRING proposable fields. `type` and `grapes` are proposable too
// (added 2026-08-19, somm ticket 6a85ad44) but validate differently — an enum
// and a taxonomy-resolved list — so they are handled apart from this loop.
const PROPOSAL_FIELDS = ['producer', 'name', 'appellation', 'region', 'country', 'classification'];
const PROPOSAL_ALL_FIELDS = [...PROPOSAL_FIELDS, 'type', 'grapes'];
const PROPOSAL_REASON_MIN = 10;
const PROPOSAL_REASON_MAX = 1000;
const PROPOSAL_FIELD_MAX = 200;
const PROPOSAL_URL_MAX = 500;

registerTool({
  name: 'propose_wine_correction',
  title: 'Sommelier: correct an identity field, merge or flag a non-wine',
  description:
    'Files a correction on a registry wine. A correction that only FILLS BLANK appellation, region or classification '
    + 'fields, and does not contradict the wine\'s own name, APPLIES IMMEDIATELY — the reply says "Applied" and gives '
    + 'the applied_note. Everything else is filed for an admin and the reply says "awaiting admin review" with '
    + 'why_reviewed: producer and name (they drive the dedup key and the public URL), country, any OVERWRITE of a '
    + 'field that already has a value, merges, non-wine flags, and any appellation that disagrees with an appellation '
    + 'stated in the wine\'s name. That last one is a ROUTING rule, not a verdict — an Australian "Prosecco" really is '
    + 'a King Valley wine and not the Italian DOC, so file it with your evidence and an admin will read it. ' +
    'THIS is the path for the identity fields set_wine_profile deliberately does not cover: producer, name, ' +
    'appellation, region, country and classification (kind "field_correction", region/country as plain names — ' +
    'resolved against the taxonomy when it applies, never minted). Also: kind "merge" when this wine duplicates another ' +
    'registry wine (merge_target_id = the wine that should SURVIVE), and kind "non_wine" when the row is not wine at ' +
    'all (spirits/cider/sake) and should be quarantined out of search and the maturity queue. Always give the reason ' +
    'the somm established, and cite an evidence_url (producer site, appellation register) — evidence is what makes a ' +
    'one-click approval possible. One pending proposal per wine and kind — list_pending_corrections shows what is ' +
    'already filed. MERGE proposals are decided in Admin → Wines on the web, DELIBERATELY not over MCP: a wine ' +
    'merge moves bottles and rewrites references (same stance as taxonomy merge), and the merge DELETES the absorbed '
    + 'record — there is no unmerge. undo_last withdraws a proposal that is still pending; one that already applied is '
    + 'changed by filing a further correction.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_maturity_queue, search_registry or get_wine'),
    kind: z.enum(PROPOSAL_KINDS),
    proposed_fields: z.object({
      producer: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      name: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      appellation: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      region: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      country: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      classification: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      type: z.enum(WINE_TYPES).optional(),
      grapes: z.array(z.string().min(1).max(GRAPE_NAME_MAX)).min(1).max(GRAPES_MAX).optional(),
    }).optional().describe('kind "field_correction" only: the corrected value per field (omit fields that are right). Region/country as plain names. `type` is the wine colour/style; `grapes` REPLACES the whole variety list (send every variety the wine has, not just the added one) and each name must already exist in the taxonomy — synonyms resolve, unknown names are refused so an approval can never mint a variety. A BRAND THAT CHANGED HANDS (somm ticket 6a8698d5): registry wines are vintage-neutral, so a producer that was acquired has no single true value. The convention is CURRENT OWNER WINS — put today\'s owner in `producer` and record the predecessor in the reason, e.g. "ZAREA acquired the brand from Domeniile Tohani in 2019". Do not uphold a suspect flag on a wine whose producer is knowable just because ownership moved: that leaves a permanent cannot-identify caveat on an identifiable wine and inflates the residue count the scaling review reads.'),
    merge_target_id: objectId.optional().describe('kind "merge" only: the duplicate\'s SURVIVING wine — must differ from wine_id'),
    evidence_url: z.string().max(PROPOSAL_URL_MAX).optional()
      .describe('http(s) URL backing the claim — cite one whenever the somm has it; it is what makes approval fast'),
    reason: z.string().min(PROPOSAL_REASON_MIN).max(PROPOSAL_REASON_MAX)
      .describe('What is wrong and how the somm verified the fix — the admin reads this verbatim'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    // Same reason hygiene as reject_price_request: plain text only, bounded
    // even after strip — the admin reads it verbatim in the review diff.
    const reason = stripHtml(typeof args.reason === 'string' ? args.reason : '');
    if (!reason || reason.length < PROPOSAL_REASON_MIN) {
      return fail('invalid_input', `reason must be at least ${PROPOSAL_REASON_MIN} characters of plain text (HTML is stripped) — say what is wrong and how it was verified.`);
    }
    if (reason.length > PROPOSAL_REASON_MAX) {
      return fail('invalid_input', `reason must be at most ${PROPOSAL_REASON_MAX} characters.`);
    }
    if (!PROPOSAL_KINDS.includes(args.kind)) {
      return fail('invalid_input', `kind must be one of: ${PROPOSAL_KINDS.join(', ')}`);
    }

    let evidenceUrl = '';
    if (args.evidence_url !== undefined && args.evidence_url !== null) {
      evidenceUrl = String(args.evidence_url).trim();
      if (evidenceUrl && !/^https?:\/\//i.test(evidenceUrl)) {
        return fail('invalid_input', 'evidence_url must be an http:// or https:// URL.');
      }
      if (evidenceUrl.length > PROPOSAL_URL_MAX) {
        return fail('invalid_input', `evidence_url must be at most ${PROPOSAL_URL_MAX} characters.`);
      }
    }

    // Per-kind shape: refuse mixed payloads loudly rather than silently
    // dropping fields the model believed would ride along.
    let proposedFields = null;
    if (args.kind === 'field_correction') {
      if (args.merge_target_id) {
        return fail('invalid_input', 'merge_target_id only applies to kind "merge" — file a separate merge proposal.');
      }
      proposedFields = {};
      const src = args.proposed_fields || {};
      for (const f of PROPOSAL_FIELDS) {
        if (src[f] === undefined || src[f] === null) continue;
        const v = String(src[f]).trim();
        if (!v) continue;
        if (v.length > PROPOSAL_FIELD_MAX) {
          return fail('invalid_input', `proposed_fields.${f} must be at most ${PROPOSAL_FIELD_MAX} characters.`);
        }
        proposedFields[f] = v;
      }
      // type: the zod enum already refused anything outside WINE_TYPES.
      if (src.type) proposedFields.type = src.type;
      // grapes: resolved against the taxonomy HERE so the curator finds out now
      // rather than when an admin tries to approve. The approve path resolves
      // again (taxonomy moves), but a name that is unknown today is almost
      // always a typo, and telling them immediately is the whole point.
      if (Array.isArray(src.grapes) && src.grapes.length) {
        const resolved = await resolveGrapeIdsStrict(src.grapes);
        if (!resolved.ok) {
          return fail('invalid_input',
            `These grape names are not in the taxonomy: ${resolved.unmatched.map((g) => `"${g}"`).join(', ')}. ` +
            'Check the spelling, or use describe_grape to find the canonical name. A proposal cannot create a variety.');
        }
        // Store the CANONICAL names: the proposal should record what will
        // actually be written, not a synonym the admin then has to decode.
        proposedFields.grapes = resolved.names;
      }
      if (Object.keys(proposedFields).length === 0) {
        return fail('invalid_input', `field_correction needs at least one non-empty field in proposed_fields (${PROPOSAL_ALL_FIELDS.join(', ')}).`);
      }
    } else {
      if (args.proposed_fields && Object.keys(args.proposed_fields).length > 0) {
        return fail('invalid_input', 'proposed_fields only applies to kind "field_correction" — file a separate field_correction proposal.');
      }
      if (args.kind === 'merge') {
        if (!args.merge_target_id) {
          return fail('invalid_input', 'kind "merge" needs merge_target_id — the registry wine this duplicate should be merged INTO.');
        }
        if (String(args.merge_target_id) === String(args.wine_id)) {
          return fail('invalid_input', 'merge_target_id must be a DIFFERENT wine — a wine cannot merge into itself.');
        }
      } else if (args.merge_target_id) {
        return fail('invalid_input', 'merge_target_id only applies to kind "merge".');
      }
    }

    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');
    const wine = await WineDefinition.findById(args.wine_id)
      .populate('country', 'name').populate('region', 'name').populate('grapes', 'name');
    if (!wine) return fail('not_found', 'No such wine. Use search_registry to find it.');

    let target = null;
    if (args.kind === 'merge') {
      if (!isValidId(args.merge_target_id)) return fail('invalid_input', 'merge_target_id must be a 24-hex id.');
      target = await WineDefinition.findById(args.merge_target_id).select('name producer');
      if (!target) return fail('not_found', 'No registry wine with that merge_target_id. Use search_registry to find the surviving wine.');
    }

    // Identity fields as they stand NOW (region/country as display names) —
    // the admin diff renders against live values and uses this to show drift.
    const currentSnapshot = {
      producer: wine.producer || null,
      name: wine.name || null,
      appellation: wine.appellation || null,
      region: wine.region?.name || null,
      country: wine.country?.name || null,
      classification: wine.classification || null,
      // Both sides of the admin drift check compare against this, so the two
      // new proposable fields have to be in it — otherwise every type/grapes
      // proposal would render as "drifted since filing" against undefined.
      type: wine.type || null,
      grapes: (wine.grapes || []).map((g) => g && g.name).filter(Boolean).join(', ') || null,
    };

    let proposal;
    try {
      proposal = await WineCorrectionProposal.create({
        proposer: ctx.user.id,
        wineDefinition: wine._id,
        kind: args.kind,
        ...(proposedFields ? { proposedFields } : {}),
        ...(target ? { mergeTargetId: target._id } : {}),
        ...(evidenceUrl ? { evidenceUrl } : {}),
        reason,
        currentSnapshot,
      });
    } catch (err) {
      // The one-pending-per-(wine, kind) partial unique index — a clean
      // conflict, not a stack trace, when a proposal is already waiting.
      if (err?.code === 11000) {
        return fail('conflict', `A pending ${args.kind} proposal already exists for this wine — an admin has not reviewed it yet. Wait for that decision instead of re-filing.`);
      }
      throw err;
    }

    logAudit(ctx.req, 'somm.wineProposal.create',
      { type: 'wine', id: wine._id },
      {
        proposalId: proposal._id, kind: args.kind,
        wine: `${wine.producer} — ${wine.name}`,
        ...(target ? { mergeTargetId: target._id } : {}),
        via: 'mcp',
      });

    // SELF-APPLY (2026-08-21). A correction that only FILLS BLANKS on
    // reversible fields, and does not contradict the wine's own name, applies
    // on filing instead of waiting for an admin — see
    // services/proposalDirectApply for why that line and not another.
    //
    // The proposal row is still written first and still carries the reason and
    // evidence: oversight moves from approve-BEFORE to review-AFTER, it does
    // not disappear. Applying through the admin route's own approveProposal
    // (rather than a second write path) is what keeps canonicalization, the
    // dedup key, the search/embed/IndexNow follow-through and the re-enrich
    // identical between the two doors.
    let applied = null;
    let reviewReason = null;
    if (args.kind === 'field_correction') {
      // Required lazily: wineProposals pulls in the whole admin route tree
      // (which requires the MCP registry back), so a top-level require here
      // would close a cycle.
      const { approveProposal } = require('../../routes/admin/wineProposals');
      const verdict = await classifyProposal(wine, args.kind, proposedFields);
      if (verdict.direct) {
        // approveProposal reads req.user.id for decidedBy and for its audit
        // attribution. ctx.req IS the express req on every real call; the
        // fallback keeps unit contexts (ctx.req: null) working.
        const asReq = ctx.req && ctx.req.user ? ctx.req : { user: { id: ctx.user.id } };
        try {
          const outcome = await approveProposal(proposal._id, asReq);
          if (outcome.status === 200) {
            applied = outcome.body?.appliedNote || 'Applied';
          } else {
            // The proposal stays pending and an admin picks it up — a failed
            // self-apply must never look like a success to the curator.
            console.warn(`[somm] self-apply declined for proposal ${proposal._id}: ${outcome.status} ${outcome.body?.error || ''}`);
          }
        } catch (err) {
          console.error(`[somm] self-apply threw for proposal ${proposal._id}:`, err.message);
        }
      } else {
        reviewReason = verdict.reason;
      }
    }

    const kindLabel = args.kind === 'merge'
      ? `merge into ${target.producer ? `${target.producer} — ` : ''}${target.name}`
      : args.kind === 'non_wine' ? 'non-wine quarantine' : 'identity-field correction';
    const envelope = applied ? {
      summary: `Applied to ${wine.producer} — ${wine.name}: ${applied}`,
      data: {
        proposal_id: proposal._id,
        wine_id: wine._id,
        kind: args.kind,
        status: 'approved',
        ...(proposedFields ? { proposed_fields: proposedFields } : {}),
        evidence_url: evidenceUrl || null,
        applied_note: applied,
        note: 'Live on the wine now. Blank identity fields that agree with the name apply on filing; '
          + 'the proposal is kept with your reason so an admin can review it afterwards.',
        undo: 'This is already applied — file a further correction to change it again.',
      },
    } : {
      summary: `Proposal filed: ${kindLabel} for ${wine.producer} — ${wine.name} (awaiting admin review)`,
      data: {
        proposal_id: proposal._id,
        wine_id: wine._id,
        kind: args.kind,
        status: 'pending',
        ...(proposedFields ? { proposed_fields: proposedFields } : {}),
        ...(target ? { merge_target: { wine_id: target._id, name: target.name, producer: target.producer || null } } : {}),
        evidence_url: evidenceUrl || null,
        ...(reviewReason ? { why_reviewed: reviewReason } : {}),
        note: 'Nothing has changed — the wine stays as-is until an admin reviews the diff and approves.',
        undo: 'undo_last withdraws the proposal while it is still pending',
      },
    };
    await logAction(ctx, {
      tool: 'propose_wine_correction',
      action: 'somm_proposal',
      detail: { proposalId: String(proposal._id), wineId: String(wine._id), kind: args.kind },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// Owner inquiries — the channel for record questions only a bottle's OWNER
// can settle ("what does the label say?"). Both tools ride the shared
// services/ownerInquiryOps so REST and MCP cannot drift on recipient
// building, conflict semantics or queue order. Recipients are ANONYMISED on
// this surface — a curator needs the answers, never the owners' identities
// (the admin REST queue is the only place identities show).
const INQUIRY_STATUS_FILTERS = ['active', 'open', 'answered', 'resolved', 'closed', 'decided'];

registerTool({
  name: 'ask_bottle_owner',
  title: 'Sommelier: ask a wine\'s bottle owners about their record',
  description:
    'Sends a question about a registry wine to the users who OWN bottles of it (in-app notification; owners answer ' +
    'from their bottle page, answers land in the owner-inquiry queue). THE tool for record facts research cannot ' +
    'settle — "what does the label say the producer is?", "is this the DOCG or the DOC bottling?". Owners with ' +
    'ACTIVE bottles are asked; when none exist, owners who consumed one are asked instead. Capped at 20 owners. One ' +
    'open inquiry per wine — a second ask conflicts until the first is resolved. Works on pending-identity wines ' +
    'too, and is the RIGHT escalation when the label scan cannot answer the question: the owner has the bottle in ' +
    'hand and can read the back label ("Mis en bouteille par…") when the front prints no producer. This notifies ' +
    'real people: confirm the wording with the somm first. NOT reversible via undo_last (notifications cannot be ' +
    'unsent). Read the answers later with list_owner_inquiries.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_maturity_queue, search_registry or get_wine'),
    question: z.string().min(QUESTION_MIN).max(QUESTION_MAX)
      .describe(`The question the owners read VERBATIM (${QUESTION_MIN}–${QUESTION_MAX} chars, plain text) — e.g. "Could you check the label: is the producer written as ‘E. Pira e Figli’ or just ‘Pira’?"`),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    // ONE implementation with the REST create route — identical validation,
    // conflict semantics and audit action string (via:'mcp' in the detail).
    const result = await createOwnerInquiry({
      wineId: args.wine_id,
      userId: ctx.user.id,
      via: 'mcp',
      question: args.question,
      req: ctx.req,
    });
    if (!result.ok) {
      if (result.code === 'not_found') return fail('not_found', result.message + ' Use search_registry to find it.');
      if (result.code === 'conflict') return fail('conflict', result.message + ' Check it with list_owner_inquiries.');
      if (result.code === 'no_owners') {
        return fail('conflict', result.message + ' There is nobody to ask — settle the record another way (propose_wine_correction with evidence, or a support ticket).');
      }
      return fail('invalid_input', result.message);
    }

    const label = [result.wine.producer, result.wine.name].filter(Boolean).join(' — ');
    return ok(
      `Inquiry sent to ${result.recipientCount} bottle owner(s) of ${label}${result.fallbackUsed ? ' (no active bottles — owners of consumed bottles were asked)' : ''}`,
      {
        inquiry_id: result.inquiry._id,
        wine_id: result.wine._id,
        status: 'open',
        recipients_notified: result.recipientCount,
        asked_consumed_owners: result.fallbackUsed,
        expires_at: result.inquiry.expiresAt,
        note: 'Owners answer in-app; answers appear in list_owner_inquiries. The inquiry expires after 60 days. Not undoable — the notifications are already out.',
      }
    );
  },
});

registerTool({
  name: 'list_owner_inquiries',
  title: 'Sommelier: list owner inquiries and their answers',
  description:
    'Lists owner inquiries (questions sent to bottle owners via ask_bottle_owner) WITH the answers owners have ' +
    'given — this is how a curator reads the replies. Answered first, then open, then decided. Pass wine_id to ' +
    'check one wine, status to narrow ("active" = open+answered is the default; "decided" = resolved+closed). ' +
    'Recipients are anonymised ("owner 1", "owner 2") — identities are never exposed here; judge the answers on ' +
    'content. Once the record is fixed, close the loop with resolve_owner_inquiry — it replies to the owners who ' +
    'answered. (Applying an IDENTITY field is still an admin step: propose_wine_correction.)',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    status: z.enum(INQUIRY_STATUS_FILTERS).optional().describe('Default "active" (open + answered)'),
    wine_id: objectId.optional().describe('Scope to one registry wine'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { limit, offset } = pageParams(args, 20, 50);

    // Expired open inquiries leave as 'closed' before the queue renders —
    // same lazy sweep the admin REST list runs.
    await sweepExpiredInquiries();

    // Filter values are literals from the static array, never raw input.
    const status = INQUIRY_STATUS_FILTERS.includes(args.status) ? args.status : 'active';
    const filter = {};
    if (status === 'active') filter.status = { $in: ['open', 'answered'] };
    else if (status === 'decided') filter.status = { $in: ['resolved', 'closed'] };
    else filter.status = status;
    // Cast REQUIRED: queryInquiryPage runs an aggregate, and Mongoose does not
    // cast $match values in pipelines — a hex STRING matches nothing while the
    // sibling countDocuments (which does cast) still counts (audit M-1).
    if (args.wine_id) filter.wineDefinition = new mongoose.Types.ObjectId(args.wine_id);

    const { rows, total, pendingCount, answeredCount } = await queryInquiryPage(filter, { limit, offset });
    await WineOwnerInquiry.populate(rows, [
      { path: 'wineDefinition', select: 'name producer type appellation', populate: ['country', 'region'] },
    ]);

    const data = rows.map((i) => ({
      inquiry_id: i._id,
      wine: wineLite(i.wineDefinition),
      status: i.status,
      question: i.question,
      asked_via: i.askedVia || 'rest',
      created_at: i.createdAt,
      expires_at: i.expiresAt || null,
      // Anonymised, positionally stable labels — answers without identities.
      recipients: (i.recipients || []).map((r, idx) => ({
        label: `owner ${idx + 1}`,
        notified_at: r.notifiedAt || null,
        responded: !!r.response,
        response: r.response || null,
        responded_at: r.respondedAt || null,
      })),
      response_count: (i.recipients || []).filter((r) => r.response).length,
      recipient_count: (i.recipients || []).length,
      resolution_note: i.resolutionNote || null,
      resolved_at: i.resolvedAt || null,
    }));

    return ok(
      `${answeredCount} inquiry(ies) with answers waiting, ${pendingCount} active in total (showing ${data.length} of ${total} ${status})`,
      data,
      { page: { limit, offset, total } }
    );
  },
});

registerTool({
  name: 'resolve_owner_inquiry',
  title: 'Sommelier: close an owner inquiry and thank the owners who answered',
  description:
    'Closes an owner inquiry and REPLIES to every owner who answered it. Two texts, two audiences: `note` is the ' +
    'curator record the admin queue reads back (what the answers settled), `owner_reply` is read VERBATIM by the ' +
    'people who walked to their shelf and read the label for you — write it to them: what they told you, what it ' +
    'changed in the record, thanks. Fix the record FIRST (set_wine_profile / fix_pending_wine, or file a ' +
    'propose_wine_correction), then close. Omitting owner_reply still sends a plain thank-you — worse, but never ' +
    'silence, which is what an unanswered helper remembers. Owners who never answered are not notified. This ' +
    'notifies real people and is NOT reversible via undo_last (notifications cannot be unsent): confirm the ' +
    'wording with the somm first.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    inquiry_id: objectId.describe('From list_owner_inquiries'),
    note: z.string().min(NOTE_MIN).max(NOTE_MAX)
      .describe(`Curator record — what was done with the answers (${NOTE_MIN}–${NOTE_MAX} chars). NOT shown to owners.`),
    owner_reply: z.string().max(OWNER_REPLY_MAX).optional()
      .describe(`What the answering owners read, verbatim (plain text, max ${OWNER_REPLY_MAX} chars).`),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    const result = await resolveOwnerInquiry({
      inquiryId: args.inquiry_id,
      userId: ctx.user.id,
      note: args.note,
      ownerReply: args.owner_reply,
      via: 'mcp',
      req: ctx.req,
    });
    if (!result.ok) {
      if (result.code === 'not_found') return fail('not_found', result.message + ' Find it with list_owner_inquiries.');
      if (result.code === 'conflict') return fail('conflict', result.message + ' Somebody else already handled it.');
      return fail('invalid_input', result.message);
    }

    const { inquiry, notified, replySent } = result;
    const label = [inquiry.wineDefinition?.producer, inquiry.wineDefinition?.name]
      .filter(Boolean).join(' — ') || 'the wine';
    const envelope = {
      summary: notified > 0
        ? `Inquiry on ${label} resolved — ${notified} owner(s) replied to`
        : `Inquiry on ${label} resolved — nobody had answered, so no owner was notified`,
      data: {
        inquiry_id: inquiry._id,
        status: inquiry.status,
        owners_notified: notified,
        reply_sent: replySent,
        acknowledgement_only: notified > 0 && !replySent,
        note: notified > 0
          ? 'The owners who answered have been notified in-app and can read this on their bottle page for 30 days. Not undoable — the notifications are already out.'
          : 'No owner had answered this inquiry, so there was nobody to reply to.',
      },
    };
    await logAction(ctx, {
      tool: 'resolve_owner_inquiry',
      action: 'somm_owner_inquiry_resolve',
      detail: { inquiryId: String(inquiry._id), notified, replied: !!replySent },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// ── Wine reports (user-filed defect reports) ─────────────────────────────────
//
// A report is a real person saying "this record is wrong" about a wine they
// own. Both tools ride services/wineReportOps so the somm surface and the
// admin REST queue cannot drift on what the reporter is told.
//
// Deliberately NOT here: applying the report's structured suggestion to the
// registry. That is an identity write, and the somm's route for identity is
// propose_wine_correction (propose, admin approves). Answering the reporter
// and closing the report is squarely somm work — the questions are usually
// maturity and profile ones the somm can already fix directly.
//
// ANONYMISED like the owner inquiries: the somm gets the report and the wine,
// never the reporter's identity.
const REPORT_STATUS_FILTERS = ['pending', 'resolved', 'dismissed', 'all'];
const REPORT_REASON_FILTERS = ['wrong_info', 'duplicate', 'inappropriate', 'wrong_price', 'wrong_tasting_profile', 'other'];

registerTool({
  name: 'list_wine_reports',
  title: 'Sommelier: list wine reports filed by users',
  description:
    'Lists defect reports users filed against registry wines ("wrong info", "wrong tasting profile", "wrong price", ' +
    'duplicate…) — the queue of records a bottle owner says are wrong. Oldest pending first: these people are ' +
    'waiting. Each row carries the reporter\'s own words, the wine as it stands now, and any structured correction ' +
    'they suggested. Reporters are ANONYMISED ("reporter") — judge the report on its content. Pass status to widen ' +
    'past the default "pending", reason to narrow to one class, wine_id for one wine. Close a report with ' +
    'respond_to_wine_report.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    status: z.enum(REPORT_STATUS_FILTERS).optional().describe('Default "pending"'),
    reason: z.enum(REPORT_REASON_FILTERS).optional().describe('Narrow to one report class'),
    wine_id: objectId.optional().describe('Scope to one registry wine'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { limit, offset } = pageParams(args, 20, 50);

    // Filter values come from the static arrays, never raw input.
    const status = REPORT_STATUS_FILTERS.includes(args.status) ? args.status : 'pending';
    const filter = {};
    if (status !== 'all') filter.status = status;
    if (REPORT_REASON_FILTERS.includes(args.reason)) filter.reason = args.reason;
    if (args.wine_id) filter.wineDefinition = new mongoose.Types.ObjectId(args.wine_id);

    const [rows, total, pendingCount] = await Promise.all([
      WineReport.find(filter)
        // Oldest first while pending — a report that has waited longest is the
        // one most likely to have been forgotten. Newest first once closed.
        .sort(status === 'pending' ? { createdAt: 1 } : { createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate({ path: 'wineDefinition', select: 'name producer type appellation', populate: ['country', 'region'] })
        .populate('duplicateOf', 'name producer')
        .lean(),
      WineReport.countDocuments(filter),
      WineReport.countDocuments({ status: 'pending' }),
    ]);

    const data = rows.map((r) => ({
      report_id: r._id,
      wine: wineLite(r.wineDefinition),
      reason: r.reason,
      // The reporter's own words — the whole point of reading the queue.
      details: r.details || null,
      suggested_correction: r.suggestedField
        ? {
          field: r.suggestedField,
          current: r.wineDefinition?.[r.suggestedField] ?? null,
          proposed: r.suggestedValue,
          note: 'Applying an identity field is an admin step — file it with propose_wine_correction if you agree.',
        }
        : null,
      duplicate_of: r.duplicateOf
        ? { wine_id: r.duplicateOf._id, name: r.duplicateOf.name, producer: r.duplicateOf.producer || null }
        : null,
      status: r.status,
      reported_at: r.createdAt,
      response_sent: r.adminResponse || null,
      responded_at: r.respondedAt || null,
    }));

    return ok(
      `${pendingCount} report(s) awaiting review (showing ${data.length} of ${total} ${status})`,
      data,
      { page: { limit, offset, total } }
    );
  },
});

registerTool({
  name: 'respond_to_wine_report',
  title: 'Sommelier: answer a wine report and close it',
  description:
    'Closes a pending wine report and NOTIFIES the person who filed it. outcome "resolved" = the report was right ' +
    'and the record has been dealt with (fix the record FIRST with set_vintage_maturity / set_wine_profile, or file ' +
    'a propose_wine_correction, then close); "dismissed" = the record stands as it is. The response is read ' +
    'VERBATIM by a real user, so write it to them, not about them: say what you checked, what changed, and why. ' +
    'Omit it and they get a plain acknowledgement — worse, but never silence. This notifies a real person and is ' +
    'NOT reversible via undo_last (notifications cannot be unsent): confirm the wording with the somm first.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    report_id: objectId.describe('From list_wine_reports'),
    outcome: z.enum(['resolved', 'dismissed'])
      .describe('"resolved" = report was right and handled; "dismissed" = record stands'),
    response: z.string().max(MAX_RESPONSE).optional()
      .describe(`What the reporter reads, verbatim (plain text, max ${MAX_RESPONSE} chars). Leave empty only when there is genuinely nothing to say.`),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    const result = await closeWineReport({
      reportId: args.report_id,
      actorId: ctx.user.id,
      outcome: args.outcome,
      response: args.response,
      req: ctx.req,
      via: 'mcp',
    });
    if (!result.ok) {
      if (result.code === 'not_found') return fail('not_found', result.message + ' Find it with list_wine_reports.');
      if (result.code === 'conflict') return fail('conflict', result.message + ' Somebody else already handled it.');
      return fail('invalid_input', result.message);
    }

    const report = result.report;
    const label = report.wineDefinition
      ? [report.wineDefinition.producer, report.wineDefinition.name].filter(Boolean).join(' — ')
      : 'the reported wine';
    const envelope = {
      summary: `Report on ${label} ${args.outcome} — reporter notified`,
      data: {
        report_id: report._id,
        status: report.status,
        response_sent: report.adminResponse || null,
        acknowledgement_only: !report.adminResponse,
        note: 'The reporter has been notified in-app and can read this on their Support page. Not undoable — the notification is already out.',
      },
    };
    await logAction(ctx, {
      tool: 'respond_to_wine_report',
      action: 'somm_wine_report_close',
      detail: { reportId: String(report._id), outcome: args.outcome, responded: !!report.adminResponse },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// ── Pending-identity queue ───────────────────────────────────────────────────
//
// Wines minted at bottle-commit from an INCOMPLETE identity: no producer, a
// sentinel one ("Unknown", "N/A"), or a geography typed into the producer box.
// The bottle saved instantly (never make adding harder); the registry row is
// hidden from everyone but its creator until a curator completes it. All three
// tools ride services/pendingWineOps, so REST and MCP cannot drift on
// projection, taxonomy resolution or conflict semantics.
//
// ANONYMISED like the owner inquiries (#930): the curator gets the wine, its
// bottle count and its IMAGES — never who added it.
const { promises: fsp } = require('fs');
const { safeUploadPath } = require('../../services/imageProcessor');
// ONE definition of "may curation read this label scan" — shared with the REST
// image gate (routes/images.js) and the retention sweep.
const { mayCurationReadScan, PROMOTED_SCAN_GRACE_DAYS } = require('../../services/labelScanAccess');

// Downscale cap for the image blocks. 1024px on the longest edge is what a
// vision model needs to read a wine label and is a large byte reduction on a
// phone capture; the total cap keeps one response inside a sane MCP payload.
const IMAGE_MAX_EDGE = 1024;
const IMAGE_TOTAL_CAP_BYTES = 4 * 1024 * 1024;

registerTool({
  name: 'list_pending_wines',
  title: 'Sommelier: list wines waiting for an identity',
  description:
    'Lists registry wines created from an INCOMPLETE identity — an unreadable label, a missing producer, or a region ' +
    'typed where the producer belongs. Their bottles are already in their owners\' cellars and work normally; the ' +
    'wine itself is hidden from every other user until a curator completes it, so this queue is what un-hides them. ' +
    'Newest first. Pass created_via to work one source at a time — "import" is typically one user\'s CSV burst and is ' +
    'best cleared in a batch, "ui" is the trickle of label scans. Each row carries image ids: call ' +
    'get_pending_wine_images to actually READ the label, then fix_pending_wine. Owners are never identified here.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    created_via: z.enum(CREATED_VIA_FILTERS).optional()
      .describe('Narrow to one entry surface — the practical way to work a large import burst'),
    include_unavailable: z.boolean().optional()
      .describe('Also list rows already recorded as having NO producer on the label (excluded by default — they have no work left). Use it to review or reverse that disposition.'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { limit, offset } = pageParams(args, 20, 50);
    const { rows, total, pendingTotal, unavailableTotal } = await queryPendingWines({
      limit, offset, createdVia: args.created_via,
      includeUnavailable: args.include_unavailable === true,
    });
    const data = rows.map((r) => ({
      wine_id: r._id,
      name: r.name,
      producer: r.producer,
      appellation: r.appellation,
      region: r.regionName,
      country: r.countryName,
      grapes: r.grapeNames,
      type: r.type,
      created_at: r.createdAt,
      created_via: r.createdVia,
      bottle_count: r.bottleCount,
      identity_unavailable: r.identityUnavailable,
      scan_image_id: r.scanImageId,
      // The optional BACK label of the same bottle: present when the front scan
      // came back incomplete and the owner took the rescue photo.
      scan_image_back_id: r.scanImageBackId,
      // Where the two labels disagreed at scan time. The FRONT value is what
      // was stored — a curator reading "producer: front 'Ch. Musar', back
      // 'Musar SAL'" can usually settle the row without opening the photos.
      // Omitted entirely on rows with one frame, which is most of them.
      ...(r.scanFieldConflicts && r.scanFieldConflicts.length
        ? { front_back_disagreements: r.scanFieldConflicts }
        : {}),
      bottle_image_ids: r.bottleImageIds,
      has_images: !!(r.scanImageId || r.scanImageBackId || r.bottleImageIds.length),
    }));
    return ok(
      `${pendingTotal} wine(s) awaiting an identity (showing ${data.length} of ${total}${args.created_via ? ` via ${args.created_via}` : ''})` +
      (unavailableTotal ? `; ${unavailableTotal} more recorded as having no producer on the label` : ''),
      data,
      { page: { limit, offset, total } }
    );
  },
});

registerTool({
  name: 'get_pending_wine_images',
  title: 'Sommelier: read a wine\'s label scan and public photos',
  description:
    'Returns the actual PHOTOS for one wine — as images you can look at, downscaled server-side, each preceded by a ' +
    'caption saying what it is. THIS is how the pending-identity queue gets fixed: read the producer, appellation ' +
    'and classification off the label, then call fix_pending_wine with what the label says. Do not guess from the ' +
    'broken name string when a photo is available. ' +
    'What comes back depends on what exists, not on whether the wine is in the queue: the LABEL SCAN (front, and ' +
    'the back label when the owner photographed that too) while it is inside its window — always for a pending ' +
    'wine, and for 7 days after a wine leaves the queue so a wrong completion can still be corrected, after which ' +
    'it is deleted; the wine\'s APPROVED PUBLIC gallery photos for ANY wine, pending or long since published, ' +
    'exactly the set the public wine page already shows anyone (credit included when stored); and, for a PENDING ' +
    'wine only, up to 3 of its owners\' own bottle photos. Once a wine has left the queue those private photos are ' +
    'private again — but its published ones are not, so a promoted wine is worth asking about. ' +
    'A wine with no scan and no public photo says so — judge it on its text or use ask_bottle_owner, never invent ' +
    'a producer. A gallery photo may not show the label at all; read it for what it can actually settle.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_pending_wines'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');

    // WHAT MAY BE SERVED, and why — three separate questions, deliberately not
    // one (prod 2026-08-13: this tool refused a promoted wine with "That wine
    // has no label scan" while its scan existed, and refused another whose
    // APPROVED PUBLIC photo the wine page renders to anonymous visitors).
    //
    //   scan frames  — curation evidence. Readable while they EXIST and are
    //                  inside their window: pending → readable, promoted →
    //                  readable until retainUntil passes (services/
    //                  labelScanAccess, one definition shared with the REST
    //                  sibling and the retention sweep). QUEUE MEMBERSHIP IS
    //                  NOT THE GATE. The somm who reported it put it exactly
    //                  right: "scans that failed badly stay readable; scans
    //                  that failed subtly do not — the gate is inverted
    //                  against need."
    //   public gallery — the wine's approved+public photos, for ANY wine. The
    //                  web page already serves these to anybody with the URL,
    //                  so serving them here is ZERO new exposure, and refusing
    //                  them while claiming privacy is simply false.
    //   private photos — the owners' own bottle photos. STILL pending-only
    //                  (security audit M-1): shipping somebody's private
    //                  gallery to an external model is justified by a curator
    //                  reading a label they were asked to identify, and by
    //                  nothing else. Unchanged.
    const BottleImage = require('../../models/BottleImage');
    const Bottle = require('../../models/Bottle');
    const wine = await WineDefinition.findById(args.wine_id)
      .select('name producer pendingIdentity scanImage scanImageBack scanFieldConflicts').lean();
    if (!wine) return fail('not_found', 'No wine with that id. Use list_pending_wines for valid ids.');

    const stillPending = wine.pendingIdentity === true;
    const loadScan = async (id) => (id
      ? BottleImage.findById(id).select('_id kind side originalUrl processedUrl retainUntil').lean()
      : null);
    const scan = await loadScan(wine.scanImage);
    // The optional BACK label of the same bottle (the rescue scan). Gated on
    // its OWN retainUntil as well as the front's: a wine may carry only a back
    // frame — the front scan 422'd and its frame was never committed — and
    // reading the gate off a missing front would hide the only evidence there
    // is.
    const scanBack = await loadScan(wine.scanImageBack);

    // PER-IMAGE readability, not the pair's (release-audit M-2): each frame
    // carries its own retainUntil, and if they ever diverge (the retention job
    // explicitly anticipates a back scan added later) the expired one must not
    // ride the other's grace window.
    const readableScans = [];
    if (scan && mayCurationReadScan(wine, scan)) readableScans.push(scan); // the scanned label first — primary evidence
    // …then the back label, when the owner took the rescue photo. Second
    // because the front is what names the wine; the back is what usually names
    // the producer and the appellation the front left off.
    if (scanBack && mayCurationReadScan(wine, scanBack)) readableScans.push(scanBack);

    // The PUBLIC gallery — byte-for-byte the filter GET /api/images/wine/:id
    // serves the web (status approved + visibility public, official image
    // first), so this surface can never show more than the page does. The
    // kind exclusion is belt-and-braces: a label scan is always private, so it
    // cannot match anyway.
    // BOTH linkage forms (v1.111.0 hotfix — first prod smoke): an approved
    // public photo may hang off the WINE or off one of its BOTTLES, and the
    // wine page renders both — the somm's very example (Wynns "The Original",
    // credited to its owner) is bottle-linked and was still refused. The
    // distinct() runs for any wine because it only feeds this approved+public
    // query; the PRIVATE both-ways owner query above stays pending-only (M-1).
    const galleryBottleIds = (await Bottle.distinct('_id', { wineDefinition: wine._id })) || [];
    const gallery = await BottleImage.find({
      $or: [
        { wineDefinition: wine._id },
        ...(galleryBottleIds.length ? [{ bottle: { $in: galleryBottleIds } }] : []),
      ],
      status: 'approved',
      visibility: 'public',
      kind: { $ne: 'label-scan' },
    }).select('_id kind status visibility credit originalUrl processedUrl')
      .sort({ assignedToWine: -1, createdAt: -1 }).limit(MAX_BOTTLE_IMAGES).lean();

    if (readableScans.length === 0 && gallery.length === 0 && !stillPending) {
      // Two states, two truths. The old message asserted an expiry for both, so
      // a curator asking about a wine that was never added from a photo was
      // told its window "has closed" — i.e. that evidence had existed and they
      // were too late.
      if (!scan && !scanBack) {
        return fail('conflict',
          'That wine has no label scan — it was not added from a photo — and no public gallery photo either, so there '
          + 'is nothing to look at. Its owners\' bottle photos are private. Use ask_bottle_owner if the label is the '
          + 'only thing that can settle this.');
      }
      return fail('conflict',
        `That wine's label scan is gone — its ${PROMOTED_SCAN_GRACE_DAYS}-day correction window has closed — and the `
        + 'wine has no public gallery photo either. Use ask_bottle_owner if the label is the only thing that can settle this.');
    }

    // "Which images belong to this wine" has exactly one definition — the same
    // both-ways match the queue projection uses (some upload paths stamp the
    // wine on the image, the plain add flow only links it to the bottle).
    // `status`/`visibility` ride along so each photo can be captioned for what
    // it actually is. PENDING ONLY, unchanged: M-1 stands.
    const bottleIds = stillPending ? await Bottle.distinct('_id', { wineDefinition: wine._id }) : [];
    const imgs = stillPending ? await BottleImage.find({
      kind: { $ne: 'label-scan' },
      $or: [{ wineDefinition: wine._id }, ...(bottleIds.length ? [{ bottle: { $in: bottleIds } }] : [])],
    }).select('_id kind status visibility credit originalUrl processedUrl')
      .sort({ createdAt: -1 }).limit(MAX_BOTTLE_IMAGES).lean() : [];

    const ordered = [...readableScans, ...imgs];
    // Gallery photos FILL the same photo budget rather than adding a second
    // one, and only where they are not already in `imgs` (on a pending wine the
    // both-ways query above has usually picked them up already).
    const seen = new Set(imgs.map((i) => String(i._id)));
    for (const g of gallery) {
      if (ordered.length - readableScans.length >= MAX_BOTTLE_IMAGES) break;
      if (seen.has(String(g._id))) continue;
      ordered.push(g);
    }

    if (ordered.length === 0) {
      return ok(
        `No photos are stored for "${wine.name}" — this row has to be judged on its text alone`,
        { wine_id: wine._id, images: 0, still_pending: stillPending }
      );
    }

    // sharp is already a backend dependency (services/imageSanitizer) —
    // nothing new is added for this.
    const sharp = require('sharp');
    const blocks = [];
    const included = [];
    let totalBytes = 0;
    for (const doc of ordered) {
      // The ORIGINAL is what a curator wants: background removal can eat a
      // corner of the label. Fall back to the processed render if it is gone.
      const url = doc.originalUrl || doc.processedUrl;
      if (!url || typeof url !== 'string' || !url.startsWith('/api/uploads/')) continue;
      try {
        const buf = await fsp.readFile(safeUploadPath(url.replace('/api/uploads/', '')));
        const out = await sharp(buf)
          .rotate()
          .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        // Cap the WHOLE response, not each image: 4 MB is the budget, and a
        // curator would rather see two labels than be refused all of them.
        if (totalBytes + out.length > IMAGE_TOTAL_CAP_BYTES) break;
        totalBytes += out.length;
        // A caption block BEFORE each image, because a queue row can now carry
        // two label frames of one bottle and "the producer is not printed on
        // this one" means opposite things about a front and a back label. The
        // ids in `data.images` alone cannot carry that: nothing ties an id to a
        // position in the image stream.
        const isScan = (doc.kind || 'bottle') === 'label-scan';
        const face = doc.side === 'back' ? 'BACK' : 'FRONT';
        // A published gallery photo and somebody's private bottle photo are
        // different things and must not be captioned alike — one is what every
        // visitor to the wine page sees, the other is released to curation for
        // one purpose. Derived from the doc rather than from which query it
        // came out of, so the two paths can never label the same row
        // differently.
        const isPublic = !isScan && doc.status === 'approved' && doc.visibility === 'public';
        const credit = typeof doc.credit === 'string' && doc.credit.trim() ? doc.credit.trim() : null;
        let caption;
        if (isScan) caption = `the ${face} LABEL frame the owner scanned`;
        else if (isPublic) caption = `a PUBLIC gallery photo of this wine${credit ? ` (credit: ${credit})` : ''}`;
        else caption = "a photo of the owner's bottle";
        blocks.push({
          type: 'text',
          text: `Image ${included.length + 1} — ${caption} (image_id ${doc._id})`,
        });
        blocks.push({ type: 'image', data: out.toString('base64'), mimeType: 'image/jpeg' });
        // Marked private unless the owner published it: these are somebody's
        // own bottle photos, released to curation for one purpose only.
        included.push({
          image_id: String(doc._id),
          kind: doc.kind || 'bottle',
          // Only meaningful for a label scan; a gallery photo is always 'front'
          // by schema default and nothing should read it as a claim.
          ...(isScan ? { side: doc.side === 'back' ? 'back' : 'front' } : {}),
          private: !isPublic && doc.visibility !== 'public',
          ...(isPublic ? { public_gallery: true } : {}),
          ...(credit ? { credit } : {}),
        });
      } catch (err) {
        console.warn('[mcp] pending-wine image read failed:', err.message);
      }
    }
    if (included.length === 0) {
      return fail('unavailable', 'The stored photos for this wine could not be read right now — retry later, or judge the row on its text.');
    }

    // Text part FIRST so the model reads the instruction before the pixels.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: `${included.length} photo(s) for "${wine.name}"${wine.producer ? ` — ${wine.producer}` : ' (no producer recorded)'}`,
            data: {
              wine_id: wine._id,
              still_pending: stillPending,
              // Only present after promotion: how long the label stays
              // correctable. The model should say so when it reports a fix.
              ...(stillPending ? {} : { correction_window_until: scan?.retainUntil || scanBack?.retainUntil || null }),
              images: included,
              // What the two labels disagreed about at scan time, front value
              // kept. Absent unless a back-label rescue scan actually ran.
              ...((wine.scanFieldConflicts || []).length
                ? { front_back_disagreements: wine.scanFieldConflicts.map((c) => ({ field: c.field, front: c.front, back: c.back })) }
                : {}),
              guidance: stillPending
                ? 'Read the producer, appellation and classification off the label. Transcribe what is printed — never infer a producer from the region. These are the owner\'s private photos, released for this one purpose: do not describe, store or reuse them for anything but completing this wine\'s identity.'
                : readableScans.length
                  ? 'This wine has already left the pending queue — you are looking at its label inside the correction window, to CHECK an identity somebody already wrote. If it is wrong, propose the correction (propose_wine_correction); do not describe, store or reuse this photo for anything else.'
                  // No scan (expired, or the wine never had one) but the wine
                  // publishes photos. Say plainly what they are, so the model
                  // does not read a marketing shot as a label transcription.
                  : 'No label scan is available for this wine — what you are looking at is its PUBLIC gallery, the same photos the wine page shows to anyone. Read them for what they can settle and no more: a gallery shot may not show the label at all. If the record looks wrong, propose the correction (propose_wine_correction) or ask the owners (ask_bottle_owner).',
            },
          }),
        },
        ...blocks,
      ],
    };
  },
});

registerTool({
  name: 'fix_pending_wine',
  title: 'Sommelier: complete a pending wine\'s identity',
  description:
    'Writes the corrected identity onto one wine in the pending-identity queue: producer, name, appellation, region, ' +
    'country, grapes, type. The moment producer AND name are both real the wine is PROMOTED automatically — it enters ' +
    'registry search, gets embedded, and its vintages enter the maturity queue — so send both in one call whenever ' +
    'you can. Region and country are plain NAMES resolved against the taxonomy (the country must already exist; grape ' +
    'synonyms resolve, unknown varieties are refused, never created). Refuses a wine that is no longer pending. This ' +
    'is SHARED registry data other users will see: base it on the label photo (get_pending_wine_images) or on the ' +
    'somm\'s own knowledge, never on a guess from the broken string. When the label genuinely prints no producer at ' +
    'all, identity_unavailable clears the row from the queue WITHOUT promoting it — read its description first.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_pending_wines'),
    producer: z.string().min(1).max(FIELD_MAX).optional().describe('The winery exactly as printed on the label'),
    name: z.string().min(1).max(FIELD_MAX).optional().describe('The cuvée/wine name WITHOUT the producer in it'),
    appellation: z.string().max(FIELD_MAX).optional().describe('Empty string clears it'),
    region: z.string().max(FIELD_MAX).optional().describe('Region NAME; empty string clears it'),
    country: z.string().max(FIELD_MAX).optional().describe('Country NAME — must already exist in the taxonomy'),
    grapes: z.array(z.string().min(1).max(GRAPE_NAME_MAX)).max(GRAPES_MAX).optional()
      .describe('Variety NAMES, taxonomy-resolved (synonyms ok). Replaces the whole list.'),
    type: z.enum(WINE_TYPES).optional(),
    cross_field_override: z.boolean().optional()
      .describe(
        'Force through a producer the cross-field rules refuse. Use ONLY when the label plainly prints this name ' +
        'and the TAXONOMY is what is wrong — a user-minted region or appellation that happens to carry a real ' +
        'producer\'s name, which would otherwise make that producer permanently unwritable. Never use it to push ' +
        'through a place or a grape you read off the label as a producer. Requires a producer in the same call, and ' +
        'is recorded in the audit log with the rules it overrode.'
      ),
    identity_unavailable: z.boolean().optional()
      .describe(
        'LAST RESORT — only after asking the bottle\'s owner (ask_bottle_owner works on pending wines) and being ' +
        'told the label genuinely prints NO producer: a retailer own-label, a négociant clean-skin, an unlabelled ' +
        'bin-end. Takes the row OUT OF THE QUEUE without promoting it: the wine stays hidden from the registry, out ' +
        'of search, embeddings and the maturity queue, exactly as it is now. Never use it to clear a row you simply ' +
        'could not read — promoting a producerless wine would wreck deduplication (producer is 45% of the score), ' +
        'and guessing a producer is worse. Reversible: send false.'
      ),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    // snake_case in, the shared validator's field names out — ONE validator
    // with the REST PATCH, so the two surfaces cannot drift.
    const patch = {};
    if (args.identity_unavailable !== undefined) patch.identityUnavailable = args.identity_unavailable;
    if (args.producer !== undefined) patch.producer = args.producer;
    if (args.name !== undefined) patch.name = args.name;
    if (args.appellation !== undefined) patch.appellation = args.appellation;
    if (args.region !== undefined) patch.regionName = args.region;
    if (args.country !== undefined) patch.countryName = args.country;
    if (args.grapes !== undefined) patch.grapeNames = args.grapes;
    if (args.type !== undefined) patch.type = args.type;
    if (args.cross_field_override !== undefined) patch.crossFieldOverride = args.cross_field_override;

    const check = validatePendingFix(patch);
    if (!check.ok) return fail('invalid_input', check.error);

    const loaded = await loadPendingWine(args.wine_id);
    if (!loaded.ok) return fail(loaded.code, loaded.message);

    const applied = await applyPendingFix(loaded.wine, check.clean, ctx.user.id);
    if (!applied.ok) return fail(applied.code, applied.message);
    const { wine, promoted, diff, crossFieldOverridden } = applied;

    // Same audit action string as the REST PATCH — REST and MCP curation must
    // audit identically (this file's header rule), override metadata included.
    logAudit(ctx.req, 'wine.pending_fix', { type: 'wine', id: wine._id }, {
      fields: Object.keys(check.clean), diff, promoted, via: 'mcp',
      ...(crossFieldOverridden ? { crossFieldOverridden } : {}),
    });

    const unavailable = wine.identityUnavailable === true;
    const envelope = {
      summary: promoted
        ? `${wine.producer} — ${wine.name}: identity completed, the wine is now live in the registry`
        : unavailable
          ? `${wine.name}: recorded as having no producer on the label — out of the queue, still not in the registry`
          : `${wine.name}: saved, but still missing a producer — it stays in the pending queue`,
      data: {
        wine_id: wine._id,
        promoted,
        still_pending: !promoted,
        identity_unavailable: unavailable,
        producer: wine.producer || null,
        name: wine.name,
        appellation: wine.appellation || null,
        type: wine.type || null,
        ...(applied.grapeNames ? { grapes: applied.grapeNames } : {}),
        changed: Object.keys(diff),
        note: promoted
          ? 'The wine is now searchable, embedded, and its vintages are in the maturity queue.'
          : unavailable
            ? 'It stays hidden from the registry and its owner keeps their bottle. Send identity_unavailable: false to put it back in the queue.'
            : 'Send a producer to promote it — everything else is optional.',
      },
    };
    await logAction(ctx, {
      tool: 'fix_pending_wine',
      action: 'somm_pending_fix',
      detail: {
        wineId: String(wine._id), fields: Object.keys(check.clean), promoted,
        ...(crossFieldOverridden ? { crossFieldOverridden } : {}),
      },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// ── Colour-conflict worklist (somm ticket 6a85f256, 2026-08-19) ────────────
// v1.141.0 shipped the grape_colour_conflict HOLD, which gates new
// generations — but the rows already in the registry were found by a
// retroactive scan and were never held, so `held_reason:"grape_colour_conflict"`
// returned nothing and the only way to reach them was a list pasted into a
// support ticket. Work that lives outside the app is work that does not get
// done, and it is not countable.
//
// These rows deliberately are NOT held: holding would unpublish a profile that
// is live on a bottle page, and the contradiction is in the RECORD (type vs
// grapes), not in the profile. So they get their own worklist instead, reading
// the same rule the admin cross-field queue reads — one source of truth.
registerTool({
  name: 'list_colour_conflicts',
  title: 'Sommelier: wines whose stored type contradicts every grape on them',
  description:
    'Registry wines where the stored type disagrees with the curated colour of EVERY grape on the record — a red ' +
    'made only from white varieties, or a white made only from red ones whose name makes no white claim. Purely ' +
    'deterministic: it reads stored fields against curated Grape.color and involves no model output, so a hit is a ' +
    'fact about the record rather than an opinion about the wine. It does NOT presume which field is wrong — ' +
    'Tyrrell\'s "Old Hut Semillon" stored white with Syrah is a wrong GRAPE, not a wrong type — so read the row and ' +
    'decide. Fix with propose_wine_correction (type and/or grapes; admin-approved) or set_wine_profile (immediate, ' +
    'and it stamps curator-verified). Two exclusions are deliberate and not misses: rosé is never judged, because ' +
    'Grape.color is a Red/White binary that cannot express the pink skins behind ramato, pink Muscat and orange ' +
    'wines; and a white from red grapes is exempt when the name says so (Blanc de Noirs, Bianco, Pinotage Blanc).',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    counts_only: z.boolean().optional().describe('Return just the total, for tracking the queue without paging it'),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { scanCrossFieldChecks } = require('../../services/crossFieldScan');
    const RULE = 'grape-colour-contradiction.v1';
    // ignoreCleared:false — an admin who cleared the rule on a row has judged
    // it, and this list honours that exactly like the web queue does.
    const scan = await scanCrossFieldChecks({ checkIds: [RULE] });
    const all = scan.rows.filter((r) => r.hits.some((h) => h.check === RULE));

    if (args.counts_only) {
      return ok(`${all.length} wine(s) whose stored type contradicts every grape on them.`, { total: all.length });
    }

    const page = all.slice(args.offset, args.offset + args.limit);
    const rows = page.map((r) => ({
      wine_id: String(r.wine._id),
      producer: r.wine.producer || null,
      name: r.wine.name || null,
      type: r.wine.type || null,
      grapes: (r.wine.grapes || []).map((g) => g.name),
      conflict: r.hits.find((h) => h.check === RULE)?.detail || null,
    }));
    return ok(
      `${all.length} colour conflict(s); showing ${rows.length} from ${args.offset}. Either the type or the grape ` +
      'list is wrong on each — the check does not presume which.',
      { total: all.length, limit: args.limit, offset: args.offset, wines: rows }
    );
  },
});

// Somm ticket 6a869911 (2026-08-20): list_colour_conflicts shipped read-only,
// so a row only a LABEL can settle was re-researched every session — Palazzo
// Maffei's "Conte di Valle" is a range spanning a Sauvignon, a Lugana, a
// Ripasso and an Amarone, so red + Sauvignon Blanc could be a mis-typed white
// or a clobbered grape list, and no amount of desk research decides which.
//
// This needs no new state. crossChecksCleared already exists, the admin queue
// already writes it, and list_colour_conflicts already honours it because it
// runs through scanCrossFieldChecks — so one dismissal drops the row out of
// BOTH surfaces, and it is restorable. Reusing that beats inventing a parallel
// "awaiting label" status that would then need its own queue, its own counts
// and its own way of being wrong.
const COLOUR_RULE = 'grape-colour-contradiction.v1';

registerTool({
  name: 'dismiss_colour_conflict',
  title: 'Sommelier: set a colour conflict aside as un-settleable from stored data',
  description:
    'Drops a row out of list_colour_conflicts (and the admin cross-field queue) after you have looked at it and ' +
    'concluded the record cannot be settled without evidence we do not have — typically a producer whose range ' +
    'uses one name across several colours, where only the label decides. This records a REVIEW, not a fix: the ' +
    'record keeps its contradiction and the reason is kept as the durable note of why it was set aside. Use ' +
    'restore_colour_conflict to bring it back when a label or an owner answer arrives, and consider ask_bottle_owner ' +
    'first — the owner is holding the evidence. Do NOT dismiss a row you simply have not researched yet.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_colour_conflicts'),
    reason: z.string().min(10).max(500).describe('Why it cannot be settled from stored data — kept as the review record'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');

    const wine = await WineDefinition.findById(args.wine_id).select('name producer crossChecksCleared');
    if (!wine) return fail('not_found', 'No such wine.');
    if ((wine.crossChecksCleared || []).includes(COLOUR_RULE)) {
      return fail('conflict', 'That row is already set aside — restore_colour_conflict brings it back.');
    }

    // Re-detect rather than trust the caller: the row may have been FIXED since
    // the list was read, and setting aside a wine that no longer conflicts
    // would hide a clean record from a check it now passes.
    const { findGrapeColourConflict } = require('../../utils/grapeColourCheck');
    const full = await WineDefinition.findById(args.wine_id).populate('grapes', 'name color').lean();
    if (!findGrapeColourConflict(full)) {
      return fail('invalid_input', 'That wine no longer trips the colour check — nothing to set aside.');
    }

    await WineDefinition.updateOne({ _id: wine._id }, {
      $addToSet: { crossChecksCleared: COLOUR_RULE },
      $set: { crossChecksClearedAt: new Date() },
    });
    logAudit(ctx.req, 'somm.colourConflict.dismiss', { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer, reason: args.reason, via: 'mcp' });

    return ok(`Set aside: ${wine.producer} — ${wine.name}. It will not reappear in list_colour_conflicts until restored.`,
      { wine_id: String(wine._id), dismissed: true });
  },
});

registerTool({
  name: 'restore_colour_conflict',
  title: 'Sommelier: return a set-aside colour conflict to the worklist',
  description:
    'Undoes dismiss_colour_conflict — use when a label photo, an owner answer or a producer reply arrives and the ' +
    'row can finally be decided. The record itself is never changed by either verb.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { wine_id: objectId.describe('A wine previously passed to dismiss_colour_conflict') },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');
    const wine = await WineDefinition.findById(args.wine_id).select('name producer crossChecksCleared');
    if (!wine) return fail('not_found', 'No such wine.');
    if (!(wine.crossChecksCleared || []).includes(COLOUR_RULE)) {
      return fail('invalid_input', 'That row is not set aside.');
    }
    await WineDefinition.updateOne({ _id: wine._id }, { $pull: { crossChecksCleared: COLOUR_RULE } });
    logAudit(ctx.req, 'somm.colourConflict.restore', { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer, via: 'mcp' });
    return ok(`Back in the worklist: ${wine.producer} — ${wine.name}.`, { wine_id: String(wine._id), dismissed: false });
  },
});

// Somm ticket 6a86baca (2026-08-20). A deterministic rule that moves rows OUT
// of a queue is invisible by construction: the rows stop appearing anywhere,
// so a rule that is subtly wrong keeps being right as far as anyone can see.
// Their condition for accepting the epistemic rule was that the moved rows
// stay findable as a set — "residue should be a query, not a queue" — which is
// what aiProfile.suspectDowngradedBy records and this reads back.
registerTool({
  name: 'list_rule_downgrades',
  title: 'Sommelier: wines a deterministic rule moved out of the suspect queue',
  description:
    'Registry wines whose producer_suspect flag was cleared by a RULE rather than by a human, tagged with which ' +
    'rule did it. Three rules exist. `note_asserts_producer` fires when the note calls the entity a real producer ' +
    '("a cooperative cellar in Burgundy") while the flag says the field is not one. `note_epistemic_only` fires ' +
    'when the note reports only that the model could not place the name ("not a producer I can verify") and makes ' +
    'no claim about what the field is instead — producer_suspect asserts a positive suspicion, and an epistemic ' +
    'note contains no such assertion. Both leave the row as producerUnknown: a real winery we cannot place, ' +
    'published without an owner-visible caveat. `note_doubts_cuvee_not_producer` (somm 6a872291) fires when the ' +
    'doubt is scoped to the WINE NAME or a quoted other entity while the producer is named affirmatively — "La ' +
    'Libertad appears to be a label or line from Bodega Benegas" doubts the cuvée, not the estate; it declines ' +
    'whenever any clause doubts the producer itself, and lands clean, or on producerUnknown when the note also ' +
    'carries first-person doubt about the producer. This list exists so a rule that turns out to be wrong can be found ' +
    'and reversed as a set instead of re-derived — spot-check a sample, and if a row should not have moved, ' +
    'propose_wine_correction or set_wine_profile still work on it normally. A row a HUMAN judged carries ' +
    'suspectDecision instead and never appears here. One documented semantic (audit 6a86dad6): the tag records ' +
    'which rule FIRED under strongest-claim-first precedence, not which shape the note best fits — a note that ' +
    'textually asserts a producer can carry the epistemic tag when the assertion regex did not match it; the ' +
    'outcome is identical either way.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    rule: z.enum(['note_asserts_producer', 'note_epistemic_only', 'note_doubts_cuvee_not_producer']).optional()
      .describe('Only rows moved by this rule; omit for all'),
    counts_only: z.boolean().optional().describe('Return just the totals, per rule'),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    const filter = {
      'aiProfile.suspectDowngradedBy': args.rule ? args.rule : { $ne: null },
      nonWine: { $ne: true },
    };

    if (args.counts_only) {
      const per = await WineDefinition.aggregate([
        { $match: { 'aiProfile.suspectDowngradedBy': { $ne: null }, nonWine: { $ne: true } } },
        { $group: { _id: '$aiProfile.suspectDowngradedBy', n: { $sum: 1 } } },
      ]);
      const by = Object.fromEntries(per.map((r) => [r._id, r.n]));
      const total = per.reduce((s, r) => s + r.n, 0);
      return ok(`${total} wine(s) downgraded by rule.`, { total, by_rule: by });
    }

    const total = await WineDefinition.countDocuments(filter);
    const page = await WineDefinition.find(filter)
      .select('name producer appellation aiProfile.producerNote aiProfile.suspectDowngradedBy aiProfile.confidence aiProfile.generatedAt')
      .populate('country', 'name')
      .sort({ 'aiProfile.generatedAt': -1 })
      .skip(args.offset).limit(args.limit).lean();

    const rows = page.map((w) => ({
      wine_id: String(w._id),
      producer: w.producer || null,
      name: w.name || null,
      country: w.country?.name || null,
      appellation: w.appellation || null,
      rule: w.aiProfile?.suspectDowngradedBy || null,
      confidence: w.aiProfile?.confidence ?? null,
      producer_note: w.aiProfile?.producerNote || null,
    }));
    return ok(
      `${total} rule-downgraded wine(s); showing ${rows.length} from ${args.offset}. Each is now producerUnknown — ` +
      'read the note against the producer field and say if any should not have moved.',
      { total, limit: args.limit, offset: args.offset, wines: rows }
    );
  },
});

// Somm ticket 6a82bfb7 (design settled 2026-08-20): descriptions asserting
// geography on records whose place fields are deliberately null. The check
// grades by FRAME, not truth — their correction to my first design, argued
// from their own Petersons disclosure paragraph, which names eight regions in
// order to say the region is unknown and must never be flagged as if it had
// asserted one. This is the published-row AUDIT surface; it deliberately does
// not share strictness with the enrichment-side notePlaceConflict blocker.
registerTool({
  name: 'list_ungrounded_descriptions',
  title: 'Sommelier: published descriptions claiming places the record does not carry',
  description:
    'Registry wines whose PUBLISHED AI description names a place or variety on a record that has NO region and NO ' +
    'appellation — so every such claim in the prose is ungrounded by construction. Each ungrounded claim is ' +
    'labelled kind: place | variety (varieties were in the original 6a82bfb7 test; the label keeps the two ' +
    'readable at a glance). The producer\'s own name and the record\'s country are subtracted from claim spans ' +
    'rather than grounding them wholesale — "Chile\'s Maipo Valley" on a Chile record reports Maipo Valley, and a ' +
    'mention of the producer is never a claim. Graded, never just ' +
    'counted: `assertion` = an ungrounded place stated as fact for the wine ("a red blend from the Hunter Valley" ' +
    'on a null-region row) — the class that taught a curator four wrong drink windows; `disclosure` = ungrounded ' +
    'places framed by uncertainty ("could not be identified", "the region is genuinely open", "likely…") — the ' +
    'BEST available prose for an unidentified record, listed only for completeness and NOT defects. Fix an ' +
    'assertion row by either grounding the record (propose_wine_correction with the region the description ' +
    'correctly knows — several rows are exactly this) or rewriting the prose (set_wine_profile, or a re-enrich ' +
    'via review). Never fix one by just deleting the geography sentence — silence about region always passes, and ' +
    'training enrichment toward blank confidence is the failure mode this grading exists to avoid. Curator-written ' +
    'descriptions are out of scope by construction (the 6a86dad6 exclusion, one layer up). Records that HAVE a ' +
    'region or appellation are also out of scope: prose legitimately goes finer than the record (a La Morra ' +
    'mention on a Barolo row), and judging that needs a gazetteer, not a substring.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    grade: z.enum(['assertion', 'disclosure', 'all']).default('assertion')
      .describe('assertion (default) = the defect class; disclosure = framed rows, for completeness; all = both'),
    counts_only: z.boolean().optional().describe('Return just the totals per grade'),
    limit: z.number().int().min(1).max(50).default(25),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { gradeDescription } = require('../../utils/descriptionGrounding');

    const rows = await WineDefinition.find({
      'aiProfile.description': { $ne: null },
      'aiProfile.heldAt': null,
      'aiProfile.source': { $ne: 'curator' },
      nonWine: { $ne: true },
      region: null,
      appellation: null,
    })
      .select('producer name appellation aiProfile.description aiProfile.confidence')
      .populate('region', 'name')
      .populate('country', 'name')
      .populate('grapes', 'name')
      .lean();

    // The full curated grape list, for labelling each claim place vs variety
    // (somm v1.147 audit, item 4: a field called "place" holding "Cabernet
    // Franc" reads as a broken grader to a first reader; the extraction was
    // correct — varieties were in the original 6a82bfb7 test — the label
    // wasn't).
    const Grape = require('../../models/Grape');
    const grapeVocabulary = (await Grape.find({}).select('name').lean()).map((g) => g.name);

    const graded = [];
    let okCount = 0;
    for (const w of rows) {
      const r = gradeDescription(w.aiProfile.description, {
        region: w.region?.name,
        appellation: w.appellation,
        country: w.country?.name,
        producer: w.producer,
        grapes: (w.grapes || []).map((g) => g.name),
        // The vocabulary pass reports EVERY ungrounded variety, not just the
        // one a preposition introduces (somm 6a870548 — "Cabernet Franc,
        // Petit Verdot and Merlot" reported one of three).
        varietyVocabulary: grapeVocabulary,
      });
      if (r.grade === 'ok') { okCount++; continue; }
      graded.push({ w, r });
    }
    const byGrade = {
      assertion: graded.filter((g) => g.r.grade === 'assertion'),
      disclosure: graded.filter((g) => g.r.grade === 'disclosure'),
    };

    if (args.counts_only) {
      return ok(
        `${byGrade.assertion.length} assertion / ${byGrade.disclosure.length} disclosure / ${okCount} ok, over ${rows.length} placeless published AI descriptions.`,
        { assertion: byGrade.assertion.length, disclosure: byGrade.disclosure.length, ok: okCount, scanned: rows.length }
      );
    }

    const pool = args.grade === 'all' ? graded : byGrade[args.grade];
    const page = pool.slice(args.offset, args.offset + args.limit);
    const out = page.map(({ w, r }) => ({
      wine_id: String(w._id),
      producer: w.producer || null,
      name: w.name || null,
      country: w.country?.name || null,
      grapes: (w.grapes || []).map((g) => g.name),
      grade: r.grade,
      ungrounded_claims: r.claims.map((c) => ({ claim: c.claim, kind: c.kind || 'place', framed: c.framed })),
      confidence: w.aiProfile?.confidence ?? null,
      description: String(w.aiProfile.description).slice(0, 400),
    }));
    return ok(
      `${pool.length} ${args.grade === 'all' ? 'graded' : args.grade} row(s); showing ${out.length} from ${args.offset}. ` +
      'Ground the record where the prose knows the region, rewrite where it invented one.',
      { total: pool.length, limit: args.limit, offset: args.offset, wines: out }
    );
  },
});
