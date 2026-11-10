// Sommelier tools: drink windows — the maturity queue, setting a vintage's
// window, withdrawing one and removing a pair the wine was never released in.
// Thin tools over services/maturityOps, the body the REST routes share.
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const WineDefinition = require('../../../models/WineDefinition');
const WineVintageProfile = require('../../../models/WineVintageProfile');
const { registerTool } = require('../../registry');
const { ok, fail, objectId, pageParams, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAction } = require('../../actionLedger');
const maturityOps = require('../../../services/maturityOps');
const { PHASE_FIELDS } = maturityOps;
const { hasProfileContent, UNPROFILED_QUERY } = require('../../../utils/profileReview');
const { wineLite, profileLite } = require('./shared');

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
