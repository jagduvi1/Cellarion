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
const WineDefinition = require('../../models/WineDefinition');
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const { registerTool } = require('../registry');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');
const { normalizeString, resolveCountryName, normalizeClassification } = require('../../utils/normalize');
const { otherProducerSpellings, displaySpelling } = require('../../services/producerSpelling');
const { classifyProposal } = require('../../services/proposalDirectApply');
const { WINE_COLOURS, colourTypeConflict } = require('../../utils/wineColour');
const { ok, fail, objectId, FIELD_DESCRIPTIONS, SOMM_ROLES, requireSomm } = require('../toolUtil');
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

// ── Drink windows ───────────────────────────────────────────────────────────
// list_maturity_queue, set_vintage_maturity, reset_maturity_row, remove_from_maturity_queue:
// tools/somm/maturity.js, registered here so the tool order is unchanged.
require('./somm/maturity');

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

// ── Grapes ───────────────────────────────────────────────────────────────
// add_grape, edit_grape: tools/somm/grapes.js, registered here so the tool
// order is unchanged.
require('./somm/grapes');

// ── Prices ───────────────────────────────────────────────────────────────
// list_price_tracking_requests, set_vintage_price, reject_price_request:
// tools/somm/prices.js, registered here so the tool order is unchanged.
require('./somm/prices');

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
