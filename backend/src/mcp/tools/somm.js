// Sommelier MCP tools (plan Phase-2 somm note): queue listing +
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
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const WineDefinition = require('../../models/WineDefinition');
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const { registerTool } = require('../registry');
const { logAudit } = require('../../services/audit');
const { SUPPORTED_CURRENCIES } = require('../../config/currencies');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');
const { normalizeString, sanitizeTaxonomyName, resolveCountryName, resolveGrapeName, normalizeClassification } = require('../../utils/normalize');
const { claimKey, findGrapeClaim } = require('../../services/grapeClaims');
const { otherProducerSpellings, displaySpelling } = require('../../services/producerSpelling');
const { classifyProposal } = require('../../services/proposalDirectApply');
const { WINE_COLOURS, colourTypeConflict } = require('../../utils/wineColour');
const { ok, fail, objectId, pageParams, FIELD_DESCRIPTIONS, SOMM_ROLES, requireSomm } = require('../toolUtil');
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
const priceOps = require('../../services/priceOps');
const maturityOps = require('../../services/maturityOps');
// services/search is required lazily at call time, not here: it pulls in the
// Meili client and half the model layer at module load, which every consumer
// of the tool registry would then have to stand up (registry.test.js does not).

const { PHASE_FIELDS } = maturityOps;
// "Does a stored profile exist" is one predicate for every queue here, with
// its Mongo twin beside it: utils/profileReview.js.
const { hasProfileContent, UNPROFILED_QUERY } = require('../../utils/profileReview');
// How a wine and its tasting profile read on a queue row: shared with the
// somm tool families in ./somm/.
const { wineLite, profileLite } = require('./somm/shared');

registerTool({
  name: 'list_maturity_queue',
  title: 'Sommelier: list the maturity queue',
  description:
    'Lists wine+vintage pairs awaiting drink-window review (every added bottle seeds one). Pending first, newest ' +
    'first. Call when the somm asks "anything in my maturity queue?" or before a review session. Pass wine_id ' +
    '(and optionally vintage) to fetch ONE wine\'s rows — including curator notes, which drink_window_for ' +
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
    unprofiled: z.boolean().optional().describe(
      'Only rows whose wine has NO tasting profile text. With status "reviewed" this finds windows that were written ' +
      'onto a wine nothing describes — the pass that has to be finished with set_wine_profile.'),
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
        filter.vintage = maturityOps.canonicalVintage(args.vintage);
      }
    } else if (args.unprofiled) {
      // Windowed-but-unprofiled wines: with
      // automatic enrichment off, a window written onto a wine that has no
      // description leaves the record incomplete for good unless a curator
      // finds it. Wines without profile text are few hundred, so an id list
      // keeps the page and the total honest.
      // "No profile" is the one predicate every queue uses (hasProfileContent,
      // written as a query): a HELD profile has generatedAt but no
      // description, and a curator profile may carry body/flavors without
      // prose — neither is "nothing describes the wine".
      const bare = await WineDefinition.find(UNPROFILED_QUERY).select('_id').lean();
      filter.wineDefinition = { $in: bare.map((w) => w._id) };
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
        // invisible here read as a phantom writer filling them in later.
        .populate({ path: 'wineDefinition', select: 'name producer type appellation aiProfile grapes identityProvenance labelSweetness', populate: ['country', 'region', { path: 'grapes', select: 'name' }, { path: 'labelSweetness', select: 'name band scale regulated -_id' }] })
        .lean(),
    ]);
    const data = profiles.map((p) => ({
      profile_id: p._id,
      wine: wineLite(p.wineDefinition, { termLoaded: true }),
      vintage: p.vintage,
      status: p.status,
      relative_nv: !!p.relative,
      phases: PHASE_FIELDS.reduce((acc, f) => ((acc[f] = p[f] ?? null), acc), {}),
      // The generated tasting profile the curator is about to judge the drink
      // window against. Returned so a wrong one can be corrected in the same
      // pass with set_wine_profile, instead of the curator silently working
      // around it and the bad prose surviving.
      // `source` tells the model whether a human has already vetted this.
      tasting_profile: profileLite(p.wineDefinition?.aiProfile, p.wineDefinition),
      // Somm-gated tool, so the curator's own note comes back with the row.
      // Kept out of drink_window_for, which any reader may call — see publicContent.js.
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
    // Two address forms: nothing returns a profile_id once a pair leaves the
    // pending queue, so wine_id+vintage is how a published-but-wrong window
    // is corrected over MCP. profile_id wins when both are sent; wine_id+vintage resolves
    // through the (wineDefinition, vintage) unique index, reviewed or not.
    let profile;
    if (args.profile_id) {
      profile = await WineVintageProfile.findById(args.profile_id).populate('wineDefinition', 'name producer');
      if (!profile) return fail('not_found', 'No such maturity profile. Use list_maturity_queue for valid ids.');
    } else if (args.wine_id && args.vintage) {
      // Same canonical vintage string the profiles store: trimmed, 'NV' upper.
      const vintage = maturityOps.canonicalVintage(args.vintage);
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

    // The merged window checked against the row's range (NV offsets or years),
    // retained values included, then its ordering (services/maturityOps).
    const merged = maturityOps.mergeWindow(profile, {
      earlyFrom: args.early_from, earlyUntil: args.early_until,
      peakFrom: args.peak_from, peakUntil: args.peak_until,
      lateFrom: args.late_from, lateUntil: args.late_until,
    });
    if (!merged.ok) return fail(merged.code, merged.message);
    const { next } = merged;

    // Snapshot for undo: phases + notes + review state, restored verbatim.
    const prev = maturityOps.windowSnapshot(profile);

    // Phases, note, reviewed stamp and relative flag written; the owners'
    // data version moved; audited under the action string the REST route
    // uses too.
    const isNv = await maturityOps.applyWindow(profile, next, { sommNotes: args.somm_notes, actorId: ctx.user.id, req: ctx.req, via: 'mcp' });

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
    // A window on a wine nothing describes leaves the record incomplete —
    // and with automatic enrichment off, nobody but the curator will fill it.
    // Say so in the same breath. Best-effort.
    const warnings = [];
    try {
      const wineId = profile.wineDefinition?._id || profile.wineDefinition;
      const w = await WineDefinition.findById(wineId).select('aiProfile.description aiProfile.generatedAt aiProfile.body').lean();
      if (w && !hasProfileContent(w.aiProfile)) {
        warnings.push('This wine has no tasting profile text — the window is saved, but nothing describes the wine. Write one with set_wine_profile while the research is fresh (list_maturity_queue unprofiled:true finds the others).');
      }
    } catch { /* the warning is a courtesy, never a failure */ }
    return ok(envelope.summary, envelope.data, warnings.length ? { warnings } : undefined);
  },
});

registerTool({
  name: 'reset_maturity_row',
  title: 'Sommelier: withdraw a drink window — reviewed back to pending',
  description:
    'Resets a REVIEWED wine+vintage back to pending: clears every phase and the note, drops the reviewer stamp, and ' +
    'puts the pair back in the queue as if never curated. For a window written in error — the wrong vintage, a ' +
    'non-vintage cuvée given a year, an en primeur vintage with no bottle to assess. remove_from_maturity_queue ' +
    'refuses reviewed rows, so to remove the pair entirely, reset here and then call remove_from_maturity_queue. ' +
    'Reversible via undo_last, which restores the exact window and note that were withdrawn.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    profile_id: objectId.describe('From list_maturity_queue (wine-scoped, status "reviewed")'),
    reason: z.string().max(200).optional()
      .describe('Why the window is being withdrawn, for the audit trail — e.g. "2025 Bordeaux, not bottled yet".'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const profile = await WineVintageProfile.findById(args.profile_id).populate('wineDefinition', 'name producer');
    if (!profile) return fail('not_found', 'No such maturity profile. Use list_maturity_queue for valid ids.');
    if (profile.status !== 'reviewed') {
      return fail('conflict', 'This vintage is already pending — there is no window to withdraw.');
    }

    // Same snapshot shape set_vintage_maturity logs, so undo_last's existing
    // somm_maturity branch restores it field for field with no new code.
    const prev = maturityOps.windowSnapshot(profile);

    // Cleared, pending again, stamp dropped, owners bumped, audited: the same
    // body as the REST reset (services/maturityOps).
    await maturityOps.resetWindow(profile, { reason: args.reason, req: ctx.req, via: 'mcp' });

    const envelope = {
      summary: `Withdrew the drink window on ${profile.wineDefinition?.name || 'wine'} ${profile.vintage} — back in the pending queue`,
      data: {
        profile_id: String(profile._id),
        vintage: profile.vintage,
        status: 'pending',
        next: 'call remove_from_maturity_queue to drop the pair entirely, or leave it to be re-curated',
        undo: 'undo_last restores the withdrawn window and note',
      },
    };
    await logAction(ctx, {
      tool: 'reset_maturity_row',
      action: 'somm_maturity',
      detail: { profileId: String(profile._id), vintage: profile.vintage, reset: true },
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
    'like any other wine, so if that vintage becomes real it still gets curated. Refuses a reviewed pair — call ' +
    'reset_maturity_row first. Reversible via undo_last.',
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
      return fail('conflict', 'This vintage is already reviewed — call reset_maturity_row first, then remove it.');
    }

    // Wine+vintage is all the undo needs: a removed row is the auto-seeded
    // pending stub (phases and notes only exist on reviewed rows), so undoing
    // is re-seeding, not restoring field values.
    const prev = {
      wineDefinition: String(maturityOps.wineIdOf(profile)),
      vintage: profile.vintage,
    };
    // Deleted and audited: the same body as the REST remove (services/maturityOps).
    await maturityOps.removePendingRow(profile, { reason: args.reason, req: ctx.req, via: 'mcp' });

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
    'pairings and the prose description — and the wine\'s structural record fields type, colour and grapes (a wrong type ' +
    'changes filtering, serving and storage guidance; use when e.g. a vin jaune is typed "fortified" or a cider ' +
    '"rosé"). colour is the colour of a sparkling, dessert or fortified wine — a Trento DOC or Champagne rosé is type ' +
    '"sparkling", colour "rosé"; red/white/rosé wines never carry one. Get wine_id from list_maturity_queue, search_registry or get_wine. FIELD-LEVEL: omit a field to leave ' +
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
      .describe('Plain-text tasting note shown to owners. null clears it. Never serving instructions: those come from serving_temperature_c and needs_air, composed against the vintage\'s phase on the day the page is read.'),
    serving_temperature_c: z.object({ min: z.number().int().min(0).max(30), max: z.number().int().min(0).max(30) }).nullable().optional()
      .describe('Serving temperature range in °C, set ONLY when the wine departs from its style\'s default (full reds 16–18, light reds 13–15, crisp whites 8–10, oaked whites 10–12, sparkling 6–8, rosé 8–10, sweet 6–8, fortified 12–16). null returns to the default.'),
    needs_air: z.enum(['long', 'short', 'none']).nullable().optional()
      .describe('Whether the wine needs air when young: "long" = decant one to two hours while young (tannic reds, big structured whites), "short" = a little air helps (the default for reds), "none" = never decant (fragile old wines, sparkling, most whites). The page turns this into "decant", "open ahead" or "pour carefully" from the vintage\'s phase TODAY, so the advice stays right as the wine ages. null returns to the type\'s default.'),
    type: z.enum(WINE_TYPES).optional()
      .describe('Correct the wine\'s structural type. Cannot be cleared — every wine has one.'),
    colour: z.enum(WINE_COLOURS).nullable().optional()
      .describe('The colour of a sparkling, dessert or fortified wine (e.g. a sparkling rosé: type "sparkling", colour "rosé"). Dropped on red/white/rosé wines, whose type is already the colour. null clears it.'),
    grapes: z.array(z.string().min(1).max(GRAPE_NAME_MAX)).max(GRAPES_MAX).nullable().optional()
      .describe('Replace the grape list with these variety NAMES (taxonomy-resolved, synonyms ok). null clears the list.'),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;

    // Same validator the REST route uses, so the two surfaces cannot drift.
    // snake_case is the MCP convention; map to the model's camelCase first.
    const patch = {};
    for (const f of ['body', 'tannin', 'acidity', 'sweetness', 'description', 'flavors', 'type', 'colour', 'grapes']) {
      if (args[f] !== undefined) patch[f] = args[f];
    }
    if (args.food_pairings !== undefined) patch.foodPairings = args.food_pairings;
    if (args.needs_air !== undefined) patch.needsAir = args.needs_air;
    if (args.serving_temperature_c !== undefined) {
      const r = args.serving_temperature_c;
      patch.servingTempMin = r ? r.min : null;
      patch.servingTempMax = r ? r.max : null;
    }

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
    // A user's private draft is nobody's curation work (draft design 2026-09-12).
    if (!wine || wine.draft === true) return fail('not_found', 'No such wine. Use search_registry to find it.');

    // Refused rather than accepted-and-dropped: the model hook keeps a colour
    // only on a sparkling, dessert or fortified wine.
    const colourErr = colourTypeConflict(check.clean.type || wine.type, check.clean.colour);
    if (colourErr) return fail('invalid_input', colourErr);

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
    // the vectors now, not at the next manual batch run (none is scheduled).
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
    const profileTouched = Object.keys(check.clean).some((f) => !['type', 'colour', 'grapes'].includes(f));
    const curatorNow = wine.aiProfile?.source === 'curator';
    const outcome = !profileTouched
      ? 'record fields corrected'
      : curatorNow ? 'now curator-verified' : 'cleared — still eligible for AI enrichment';
    // The write path must SAY when it stores something other than what the
    // curator sent (e.g. "Tinta Roriz" stored as Tempranillo) — surfaced in
    // the summary, the record, AND the note so no reading depth misses it.
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
          serving_temperature_c: Number.isInteger(wine.aiProfile.servingTempMin) && Number.isInteger(wine.aiProfile.servingTempMax)
            ? { min: wine.aiProfile.servingTempMin, max: wine.aiProfile.servingTempMax }
            : null,
          needs_air: wine.aiProfile.needsAir || null,
          source: wine.aiProfile.source,
        },
        record: {
          type: wine.type || null,
          colour: wine.colour || null,
          ...(grapeNames !== null ? { grapes: grapeNames } : {}),
          ...(grapeSubs.length ? { grape_substitutions: grapeSubs.map((s) => `${s.from} → ${s.to}`) } : {}),
        },
        note: (profileTouched
          ? (curatorNow
            ? 'The AI enrichment job will no longer overwrite this wine.'
            : 'Cleared without verifying — the AI enrichment job may regenerate this profile.')
          : 'Type/colour/grape corrections do not claim the tasting profile was verified.')
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
    'failing with "not in the grape taxonomy". No admin or support ticket is needed: wine data is somm-owned, and ' +
    'taxonomy is wine data. Match-first: if the name or any synonym already resolves to an existing variety, ' +
    'nothing is created and the tool tells you what it resolves to — so calling it "just in case" is safe. Include ' +
    'the synonyms owners actually write (accents, hyphens, Cynthiana-for-Norton) — they are what the resolver ' +
    'matches label text against. colour follows the registry rule: the colour of the BERRY (Red/White), null only ' +
    'for genuine edge cases. Adds are audited and attributed to you. ' +
    'A known alias such as Shiraz counts as its canonical variety (Syrah): it matches that variety, or the new ' +
    'row is stored under the canonical name and the reply says so.',
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

    const typed = sanitizeTaxonomyName(args.name);
    // A static alias ("Shiraz") is stored under its canonical variety (Syrah):
    // resolveGrapeIdsStrict folds every name through the alias map before it
    // looks a variety up, so a row named after the alias could never be reached.
    const name = sanitizeTaxonomyName(resolveGrapeName(typed));
    if (!name) return fail('invalid_input', 'name is empty after sanitising');
    const substitution = normalizeString(typed) !== normalizeString(name) ? `${typed} → ${name}` : null;
    const synonyms = [...new Set((args.synonyms || []).map((s) => sanitizeTaxonomyName(s)).filter(Boolean))]
      .filter((s) => normalizeString(s) !== normalizeString(name));

    // Every string this row would claim — canonical name and all synonyms —
    // must be unclaimed, under the same fold resolveGrapeIdsStrict uses. Two
    // varieties answering to one string would make it ambiguous for every
    // later profile write.
    const taken = await findGrapeClaim([name, ...synonyms]);
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
    // The public taxonomy lists are cached; the admin taxonomy routes clear
    // them after every change, and so does this one.
    require('../../routes/taxonomy').clearTaxonomyListCache();

    logAudit(ctx.req, 'somm.taxonomy.create',
      { type: 'grape', id: grape._id }, { name: grape.name, colour: grape.color, synonyms });

    const envelope = {
      summary: `Added "${grape.name}" (${grape.color || 'no colour'}) to the grape taxonomy${synonyms.length ? ` with ${synonyms.length} synonym(s)` : ''}` +
        (substitution ? ` — "${typed}" is a known alias, stored under its canonical name ${grape.name}` : ''),
      data: {
        grape_id: String(grape._id),
        name: grape.name,
        colour: grape.color,
        synonyms,
        ...(substitution ? { substitution } : {}),
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
    'and reads as clean. Filling a null colour can immediately surface a wine typed red whose only grape is ' +
    'white. If you see a variety with no colour, that is a silent hole in a live validation rule. ' +
    'REGIONAL NAMES render the label a drinker in that country would actually see — Gouveio on a Douro wine ' +
    'rather than Godello, Durif in Australia rather than Petite Sirah — while storage keeps ONE canonical ' +
    'variety. Pass region as well as country where a variety has several (Carignan is Mazuelo in Rioja and ' +
    'Carignano in Sardinia), and add the same string as a synonym so label text and imports resolve INBOUND too, ' +
    'not only render outbound. One display name per place — a second name for the same country/region is refused. ' +
    'Synonyms and regional names are additive; nothing is ever removed.',
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

    // Looked up under the fold the wine write path uses, so an alias finds the
    // variety set_wine_profile would store it under ("Shiraz" → Syrah).
    const key = claimKey(args.grape);
    const grape = await Grape.findOne({ $or: [{ normalizedName: key }, { normalizedSynonyms: key }] });
    if (!grape) return fail('not_found', `No variety resolves from "${args.grape}" — add_grape creates a new one.`);

    const before = { color: grape.color, synonyms: [...(grape.synonyms || [])], regionalNames: (grape.regionalNames || []).length };
    const applied = [];
    let regionalNameAdded = false;

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
        // A synonym another variety already answers to — directly or through
        // the alias map — would make the resolver ambiguous for every later write.
        const taken = await findGrapeClaim([s], { excludeId: grape._id });
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
      const existing = (grape.regionalNames || []).map((x) => ({ country: x.country, region: x.region || null, name: x.name }));
      const dup = existing.some((x) =>
        String(x.country) === String(country._id) &&
        String(x.region || '') === String(regionDoc ? regionDoc._id : '') &&
        normalizeString(x.name) === normalizeString(rn));
      if (!dup) {
        // The admin grape editor's validator, over the whole list as it will
        // be saved: one display name per (country, region) — two would make
        // the rendered label depend on array order — and at most 20.
        const { validateGrapeRegionalNames } = require('../../services/grapeRegionalNames');
        const check = await validateGrapeRegionalNames([
          ...existing,
          { country: country._id, region: regionDoc ? regionDoc._id : null, name: rn },
        ]);
        if (check.error) {
          return fail('conflict',
            `Cannot add regional name "${rn}" to "${grape.name}": ${check.error}. This tool only adds — changing or removing a ` +
            'regional name is an admin edit.');
        }
        grape.regionalNames = check.value;
        regionalNameAdded = true;
        applied.push(`regional name ${rn} (${country.name}${regionDoc ? ' / ' + regionDoc.name : ''})`);
      }
    }

    if (args.origin && !grape.origin) { grape.origin = String(args.origin).trim(); applied.push('origin'); }
    if (args.description && !grape.description) { grape.description = stripHtml(String(args.description)).trim(); applied.push('description'); }

    if (applied.length === 0) return ok(`Nothing to change on "${grape.name}" — every value given is already set.`, { grape: grape.name });
    await grape.save();

    // The same follow-through as the admin grape editor: the public taxonomy
    // lists (colour, synonyms) are cached, and regional names feed the
    // registry search index (regional display recall), so a new one rebuilds it.
    require('../../routes/taxonomy').clearTaxonomyListCache();
    if (regionalNameAdded) require('../../services/search').fullSync().catch(() => {});

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
    // Declined pairs hidden, stale-or-missing prices kept, queue order: the
    // same body as GET /api/somm/prices/queue (services/priceOps).
    const actionable = await priceOps.actionablePriceRequests(requests);

    const data = actionable.slice(0, limit).map(({ request: r, latest }) => ({
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
    const currency = priceOps.normalizeCurrency(args.currency);
    if (!currency.ok) {
      return fail('invalid_input', `Unsupported currency ${currency.value}. Supported: ${SUPPORTED_CURRENCIES.join(', ')}`);
    }
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');
    // The bottles' canonical vintage, as on REST; the refusal wording is this door's.
    const vintage = priceOps.parsePriceVintage(args.vintage);
    if (!vintage.ok) {
      if (vintage.code === 'required') return fail('invalid_input', 'vintage is required: a year or NV.');
      if (vintage.code === 'unknown') return fail('invalid_input', 'A price needs a vintage year or NV.');
      return fail('invalid_input', vintage.error);
    }
    const wine = await WineDefinition.findById(args.wine_id).select('name producer draft');
    if (!wine || wine.draft === true) return fail('not_found', 'No registry wine with that id.');

    // Rate snapshot, save, audit and the requesters' notification: the same
    // body as POST /api/somm/prices (services/priceOps).
    const entry = await priceOps.addPriceSnapshot({
      wineId: wine._id,
      vintage: vintage.value,
      price: args.price,
      currency: currency.value,
      source: args.source,
      sommNotes: args.somm_notes,
      actorId: ctx.user.id,
      wine,
      req: ctx.req,
      via: 'mcp',
    });

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

// The same bounds, audit action string and requester wording as
// POST /api/somm/prices/requests/:id/decline, from the shared service.
const { DECLINE_REASON_MIN, DECLINE_REASON_MAX } = priceOps;

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
    // The reason reaches the skip document and the requester notifications:
    // plain text only, bounded after the strip. The wording is this door's.
    const checked = priceOps.validateDeclineReason(args.reason);
    if (!checked.ok) {
      return fail('invalid_input', checked.code === 'long'
        ? `reason must be at most ${DECLINE_REASON_MAX} characters.`
        : `reason must be at least ${DECLINE_REASON_MIN} characters of plain text (HTML is stripped) — the requester(s) read it.`);
    }
    const { reason } = checked;

    const request = await PriceTrackingRequest.findById(args.request_id);
    if (!request) {
      return fail('not_found', 'No such price-tracking request — it may already be fulfilled or declined. Use list_price_tracking_requests for valid ids.');
    }

    // Skip upserted (the suppression routes/bottles.js refuses on), request
    // deleted, requesters told verbatim, audited: the same body as the REST
    // decline (services/priceOps). `prev` is all the undo has to work from.
    const { prev, wine } = await priceOps.declinePriceRequest({ request, reason, actorId: ctx.user.id, req: ctx.req, via: 'mcp' });

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

// ── Profile reads ────────────────────────────────────────────────────────
// sample_published_profiles, list_unverified_core_wines, list_pending_corrections,
// record_profile_audit: tools/somm/profileReads.js, registered here so the
// tool order is unchanged.
require('./somm/profileReads');

// ── Held-profile review queue ────────────────────────────────────────────
// list_held_profiles, review_held_profile, list_profile_audits:
// tools/somm/heldProfiles.js, registered here so the tool order is unchanged.
require('./somm/heldProfiles');

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
// but validate differently — an enum
// and a taxonomy-resolved list — so they are handled apart from this loop.
const PROPOSAL_FIELDS = ['producer', 'name', 'appellation', 'region', 'country', 'classification'];
const PROPOSAL_ALL_FIELDS = [...PROPOSAL_FIELDS, 'type', 'colour', 'grapes'];
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
    + 'the applied_note. A non-wine flag applies immediately too, unless more than three members hold bottles of the '
    + 'row. Everything else is filed for an admin and the reply says "awaiting admin review" with '
    + 'why_reviewed: producer and name (they drive the dedup key and the public URL), country, any OVERWRITE of a '
    + 'field that already has a value, merges, and any appellation that disagrees with an appellation '
    + 'stated in the wine\'s name. That last one is a ROUTING rule, not a verdict — an Australian "Prosecco" really is '
    + 'a King Valley wine and not the Italian DOC, so file it with your evidence and an admin will read it. ' +
    'THIS is the path for the identity fields set_wine_profile deliberately does not cover: producer, name, ' +
    'appellation, region, country and classification (kind "field_correction", region/country as plain names — ' +
    'resolved against the taxonomy when it applies, never minted). Also: kind "merge" when this wine duplicates another ' +
    'registry wine (merge_target_id = the wine that should SURVIVE), and kind "non_wine" when the row is not wine at ' +
    'all (beer/spirits/cider/sake/soft drinks), or nothing on the record or in research shows that it is wine, and ' +
    'should be quarantined out of search and the maturity queue — owners keep their bottles, and an admin can ' +
    'restore it. Always give the reason ' +
    'the somm established, and cite an evidence_url (producer site, appellation register) — evidence is what makes a ' +
    'one-click approval possible. One pending proposal per wine and kind — list_pending_corrections shows what is ' +
    'already filed. MERGE proposals are decided in Admin → Wines on the web, DELIBERATELY not over MCP: a wine ' +
    'merge moves bottles and rewrites references (same stance as taxonomy merge), and the merge DELETES the absorbed '
    + 'record — there is no unmerge. undo_last withdraws a proposal that is still pending; one that already applied is '
    + 'changed by filing a further correction (an applied non-wine flag is lifted by an admin). A producer spelled unlike the rest of that producer in the registry '
    + 'comes back with registry_spellings: use the registry\'s spelling unless it is the wrong one, and say which in '
    + 'the reason.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('From list_maturity_queue, search_registry or get_wine'),
    kind: z.enum(PROPOSAL_KINDS),
    proposed_fields: z.object({
      producer: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      name: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      appellation: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional().describe(FIELD_DESCRIPTIONS.appellation),
      region: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional().describe(FIELD_DESCRIPTIONS.region),
      country: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional(),
      classification: z.string().min(1).max(PROPOSAL_FIELD_MAX).optional().describe(FIELD_DESCRIPTIONS.classification),
      type: z.enum(WINE_TYPES).optional(),
      colour: z.enum(WINE_COLOURS).optional(),
      grapes: z.array(z.string().min(1).max(GRAPE_NAME_MAX)).min(1).max(GRAPES_MAX).optional(),
    }).optional().describe('kind "field_correction" only: the corrected value per field (omit fields that are right). Region/country as plain names. `type` is the wine colour/style; `colour` is the colour of a sparkling, dessert or fortified wine (a sparkling rosé is type "sparkling", colour "rosé"); `grapes` REPLACES the whole variety list (send every variety the wine has, not just the added one) and each name must already exist in the taxonomy — synonyms resolve, unknown names are refused so an approval can never mint a variety. A BRAND THAT CHANGED HANDS: registry wines are vintage-neutral, so a producer that was acquired has no single true value. The convention is CURRENT OWNER WINS — put today\'s owner in `producer` and record the predecessor in the reason, e.g. "ZAREA acquired the brand from Domeniile Tohani in 2019". Do not uphold a suspect flag on a wine whose producer is knowable just because ownership moved: that leaves a permanent cannot-identify caveat on an identifiable wine and inflates the residue count the scaling review reads.'),
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
        const v = stripHtml(String(src[f])).trim();
        if (!v) continue;
        if (v.length > PROPOSAL_FIELD_MAX) {
          return fail('invalid_input', `proposed_fields.${f} must be at most ${PROPOSAL_FIELD_MAX} characters.`);
        }
        if (f === 'classification') {
          // Same filing rule as the user path (wineProposalOps): a regulatory
          // mark is no tier and would apply as nothing at approval.
          const tier = normalizeClassification(v);
          if (!tier) continue;
          proposedFields[f] = tier;
          continue;
        }
        proposedFields[f] = v;
      }
      // type: the zod enum already refused anything outside WINE_TYPES.
      if (src.type) proposedFields.type = src.type;
      // colour: same — the enum is the validation. Whether the wine's type can
      // carry one is judged at approval, against the type it has by then.
      if (src.colour) proposedFields.colour = src.colour;
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
        // Canonical forms: an id in another letter case is the same wine.
        if (String(args.merge_target_id).toLowerCase() === String(args.wine_id).toLowerCase()) {
          return fail('invalid_input', 'merge_target_id must be a DIFFERENT wine — a wine cannot merge into itself.');
        }
      } else if (args.merge_target_id) {
        return fail('invalid_input', 'merge_target_id only applies to kind "merge".');
      }
    }

    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');
    const wine = await WineDefinition.findById(args.wine_id)
      .populate('country', 'name').populate('region', 'name').populate('grapes', 'name');
    // A user's private draft is nobody's curation work (draft design 2026-09-12).
    if (!wine || wine.draft === true) return fail('not_found', 'No such wine. Use search_registry to find it.');

    // Same rule the user path applies at filing (wineProposalOps): a colour on
    // a wine this proposal leaves red/white/rosé would be "approved" and then
    // skipped at apply — refuse it now, while the curator can still add the type.
    if (proposedFields?.colour) {
      const colourErr = colourTypeConflict(proposedFields.type || wine.type, proposedFields.colour);
      if (colourErr) return fail('invalid_input', colourErr);
    }

    let target = null;
    if (args.kind === 'merge') {
      if (!isValidId(args.merge_target_id)) return fail('invalid_input', 'merge_target_id must be a 24-hex id.');
      target = await WineDefinition.findById(args.merge_target_id).select('name producer draft');
      if (!target || target.draft === true) return fail('not_found', 'No registry wine with that merge_target_id. Use search_registry to find the surviving wine.');
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
      colour: wine.colour || null,
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
    //
    // A non-wine flag takes the same door (2026-10-13): the quarantine is one
    // reversible flag, and classifyProposal keeps the gate only for a row
    // several members hold.
    let applied = null;
    let reviewReason = null;
    if (args.kind === 'field_correction' || args.kind === 'non_wine') {
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

    // A producer spelled unlike the rest of that producer in the registry
    // (same key, same country) — said now, while the curator can still
    // re-file with the registry's spelling; otherwise the admin has to pick
    // one at approval (routes/admin/wineProposals, 2026-09-28: curator
    // corrections split 9 producers in one week this way).
    // Judged where the wine will BE: a proposed country moves it into that
    // country's spellings (the same bucket the approve checks).
    let registrySpellings = [];
    if (!applied && args.kind === 'field_correction' && (proposedFields?.producer || proposedFields?.country)) {
      const producer = proposedFields.producer ? proposedFields.producer.trim() : wine.producer;
      const currentCountry = wine.country?._id || wine.country;
      let country = currentCountry;
      if (proposedFields.country) {
        const Country = require('../../models/Country');
        const doc = await Country.findOne({ normalizedName: normalizeString(resolveCountryName(proposedFields.country)) });
        if (doc) country = doc._id;
      }
      if (displaySpelling(producer) !== displaySpelling(wine.producer) || String(country) !== String(currentCountry)) {
        registrySpellings = await otherProducerSpellings(producer, country, { excludeWineId: wine._id });
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
        ...(args.kind === 'non_wine' ? {
          note: 'Quarantined now: the row is gone from registry search and the maturity queue. Owners keep their '
            + 'bottles, and a member who adds the same drink again lands on this hidden row. The proposal is kept '
            + 'with your reason so an admin can review it afterwards.',
          undo: 'This is already applied — an admin restores it as wine in Admin → Wines → Proposals (Decided).',
        } : {
          note: 'Live on the wine now. Blank identity fields that agree with the name apply on filing; '
            + 'the proposal is kept with your reason so an admin can review it afterwards.',
          undo: 'This is already applied — file a further correction to change it again.',
        }),
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
        ...(registrySpellings.length ? {
          registry_spellings: registrySpellings,
          spelling_note: `The registry already spells this producer ${registrySpellings.map((s) => `"${s.spelling}" (${s.count} wine${s.count === 1 ? '' : 's'})`).join(', ')}. `
            + 'If that spelling is right, withdraw this with undo_last and re-file using it. If yours is right, say so in '
            + 'the reason — the admin can rename them all when approving. If they are different producers, say that.',
        } : {}),
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

// ── Owner inquiries ──────────────────────────────────────────────────────
// ask_bottle_owner, list_owner_inquiries, resolve_owner_inquiry:
// tools/somm/ownerInquiries.js, registered here so the tool order is unchanged.
require('./somm/ownerInquiries');

// ── Wine reports ─────────────────────────────────────────────────────────
// list_wine_reports, respond_to_wine_report: tools/somm/wineReports.js,
// registered here so the tool order is unchanged.
require('./somm/wineReports');

// ── Pending-identity queue ───────────────────────────────────────────────
// list_pending_wines, get_pending_wine_images, fix_pending_wine:
// tools/somm/pendingWines.js, registered here so the tool order is unchanged.
require('./somm/pendingWines');

// ── Record checks ────────────────────────────────────────────────────────
// list_colour_conflicts, dismiss_colour_conflict, restore_colour_conflict,
// list_rule_downgrades, list_ungrounded_descriptions: tools/somm/recordChecks.js,
// registered here so the tool order is unchanged.
require('./somm/recordChecks');
