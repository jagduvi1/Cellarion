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
const WineVintageProfile = require('../../models/WineVintageProfile');
const WineVintagePrice = require('../../models/WineVintagePrice');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../../models/PriceTrackingSkip');
const WineDefinition = require('../../models/WineDefinition');
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const { registerTool } = require('../registry');
const { logAudit } = require('../../services/audit');
const { SUPPORTED_CURRENCIES } = require('../../config/currencies');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');
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
} : null);

// The tasting profile as a curator needs to judge it: the values, plus WHO
// wrote them and how sure the generator was. `confidence` is the model's own
// self-rating and is not a correctness score — a 0.6 profile inverted the
// facts about a Vintage Port — so it is labelled, not thresholded.
const profileLite = (ap) => (ap && (ap.description || ap.body) ? {
  body: ap.body || null,
  tannin: ap.tannin || null,
  acidity: ap.acidity || null,
  sweetness: ap.sweetness || null,
  flavors: ap.flavors || [],
  food_pairings: ap.foodPairings || [],
  description: ap.description || null,
  source: ap.source || 'ai',
  ai_confidence: ap.source === 'curator' ? null : (ap.confidence ?? null),
  verified_at: ap.verifiedAt || null,
} : null);

registerTool({
  name: 'list_maturity_queue',
  title: 'Sommelier: list the maturity queue',
  description:
    'Lists wine+vintage pairs awaiting drink-window review (every added bottle seeds one). Pending first, newest ' +
    'first. Call when the somm asks "anything in my maturity queue?" or before a review session. Pass wine_id ' +
    '(and optionally vintage) to fetch ONE wine\'s rows — including curator notes, which the public drink_window_for ' +
    'deliberately omits; a wine-scoped call defaults to status "all" so reviewed rows show without paginating the ' +
    'whole queue. Use the returned profile_id with set_vintage_maturity (which also accepts wine_id + vintage directly).',
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
        .populate({ path: 'wineDefinition', select: 'name producer type appellation aiProfile', populate: ['country', 'region'] })
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
      tasting_profile: profileLite(p.wineDefinition?.aiProfile),
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
  title: 'Sommelier: correct a wine\'s tasting profile, type or grapes',
  description:
    'Corrects the AI-generated tasting profile on a registry wine — body, tannin, acidity, sweetness, flavours, food ' +
    'pairings and the prose description — and the wine\'s structural record fields type and grapes (a wrong type ' +
    'changes filtering, serving and storage guidance; use when e.g. a vin jaune is typed "fortified" or a cider ' +
    '"rosé"). Get wine_id from list_maturity_queue, search_registry or get_wine. FIELD-LEVEL: omit a field to leave ' +
    'it alone, pass null to CLEAR it — except type, which can only be corrected, never cleared. Grape values are ' +
    'variety NAMES resolved against the taxonomy (synonyms work: "Shiraz" finds Syrah); an unknown variety is ' +
    'refused, never created. A write that sets profile values marks the profile curator-verified, which permanently ' +
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

// Correction proposals — the human-gated tier of registry curation. Direct
// somm writes cover type/grapes/tasting profile (set_wine_profile, recoverable
// + undoable); IDENTITY fields drive dedup keys, URLs and every owner's
// display, and curator assertions on producer/name have been confidently wrong
// (5 overturned by web-verification 2026-08-10) — so those go through a
// proposal an admin diffs and applies (routes/admin/wineProposals.js), with
// the curator's research preserved as structured data instead of a prose
// ticket the admin re-types.
const PROPOSAL_KINDS = ['field_correction', 'merge', 'non_wine'];
const PROPOSAL_FIELDS = ['producer', 'name', 'appellation', 'region', 'country', 'classification'];
const PROPOSAL_REASON_MIN = 10;
const PROPOSAL_REASON_MAX = 1000;
const PROPOSAL_FIELD_MAX = 200;
const PROPOSAL_URL_MAX = 500;

registerTool({
  name: 'propose_wine_correction',
  title: 'Sommelier: propose an identity fix, merge or non-wine flag (admin-reviewed)',
  description:
    'Files a correction PROPOSAL on a registry wine for an admin to review — nothing changes until they approve. ' +
    'THIS is the path for the identity fields set_wine_profile deliberately does not cover: producer, name, ' +
    'appellation, region, country and classification (kind "field_correction", region/country as plain names — ' +
    'resolved against the taxonomy at approval, never minted). Also: kind "merge" when this wine duplicates another ' +
    'registry wine (merge_target_id = the wine that should SURVIVE), and kind "non_wine" when the row is not wine at ' +
    'all (spirits/cider/sake) and should be quarantined out of search and the maturity queue. Always give the reason ' +
    'the somm established, and cite an evidence_url (producer site, appellation register) — evidence is what makes a ' +
    'one-click approval possible. One pending proposal per wine and kind. Reversible via undo_last while pending.',
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
    }).optional().describe('kind "field_correction" only: the corrected value per field (omit fields that are right). Region/country as plain names.'),
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
      if (Object.keys(proposedFields).length === 0) {
        return fail('invalid_input', `field_correction needs at least one non-empty field in proposed_fields (${PROPOSAL_FIELDS.join(', ')}).`);
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
      .populate('country', 'name').populate('region', 'name');
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

    const kindLabel = args.kind === 'merge'
      ? `merge into ${target.producer ? `${target.producer} — ` : ''}${target.name}`
      : args.kind === 'non_wine' ? 'non-wine quarantine' : 'identity-field correction';
    const envelope = {
      summary: `Proposal filed: ${kindLabel} for ${wine.producer} — ${wine.name} (awaiting admin review)`,
      data: {
        proposal_id: proposal._id,
        wine_id: wine._id,
        kind: args.kind,
        status: 'pending',
        ...(proposedFields ? { proposed_fields: proposedFields } : {}),
        ...(target ? { merge_target: { wine_id: target._id, name: target.name, producer: target.producer || null } } : {}),
        evidence_url: evidenceUrl || null,
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
