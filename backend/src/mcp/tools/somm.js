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
const aiConfig = require('../../config/aiConfig');
const Bottle = require('../../models/Bottle');
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
const heldProfileOps = require('../../services/heldProfileOps');
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
const { HELD_QUEUE_OUTSTANDING_EXPR } = require('../../utils/profileReview');

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
      or.push({ 'aiProfile.heldAt': null, 'aiProfile.generatedAt': { $ne: null }, 'aiProfile.producerSuspect': true, 'aiProfile.description': { $ne: null } });
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
