// Sommelier tools: the profile write — a curator writes or corrects a wine's
// tasting profile, type, colour or grapes directly (recoverable and undoable).
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const WineDefinition = require('../../../models/WineDefinition');
const Grape = require('../../../models/Grape');
const { registerTool } = require('../../registry');
const { ok, fail, objectId, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAudit } = require('../../../services/audit');
const { logAction } = require('../../actionLedger');
const { WINE_COLOURS, colourTypeConflict } = require('../../../utils/wineColour');
const { PROFILE_ENUMS, WINE_TYPES, GRAPES_MAX, GRAPE_NAME_MAX, validateProfilePatch, resolveGrapeIdsStrict, applyProfilePatch, snapshotProfile } = require('../../../services/wineProfileOps');

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
    require('../../../services/search').indexWine(wine._id).catch(() => {});
    // Same follow-through as the REST route: the corrected profile must reach
    // the vectors now, not at the next manual batch run (none is scheduled).
    require('../../../services/embeddingJob').reembedActiveVintages(wine._id).catch(() => {});

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
