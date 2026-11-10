// Sommelier tools: record checks — the colour-conflict worklist, the rows a
// downgrade rule moved out of the suspect queue, and the descriptions whose
// geography the prose invented. Reads over the registry's own checks.
//
// Registered where its block sat in somm.js, so the tool order is unchanged.
const { z } = require('zod');
const WineDefinition = require('../../../models/WineDefinition');
const { DOWNGRADE_RULES } = require('../../../utils/producerSuspectCheck');
const { registerTool } = require('../../registry');
const { ok, fail, objectId, SOMM_ROLES, requireSomm } = require('../../toolUtil');
const { logAudit } = require('../../../services/audit');
const { isValidId } = require('../../../utils/validation');

// ── Colour-conflict worklist ──────────────────────────────────────────────
// The grape_colour_conflict HOLD is decided only when a profile is generated,
// so a row whose profile is already published is not held by it, and
// `held_reason:"grape_colour_conflict"` does not reach them, and without this
// list the only way to work them would be outside the app. Work that lives
// outside the app is work that does not get done, and it is not countable.
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
    const { scanCrossFieldChecks } = require('../../../services/crossFieldScan');
    const RULE = 'grape-colour-contradiction.v1';
    // ignoreCleared:false — an admin who cleared the rule on a row has judged
    // it, and this list honours that exactly like the web queue does.
    const scan = await scanCrossFieldChecks({ checkIds: [RULE] });
    const all = scan.rows.filter((r) => r.hits.some((h) => h.check === RULE));

    // A variety with no curated colour is skipped by the rule, not passed by
    // it: name the colourless ones in use, so a zero reads as
    // "zero among the evaluable rows" rather than as a clean registry.
    const unevaluated = await colourlessVarietiesInUse();
    const caveat = unevaluated.count
      ? ` ${unevaluated.count} colourless variet${unevaluated.count === 1 ? 'y is' : 'ies are'} in use and never ` +
        `evaluated (${unevaluated.names.slice(0, 8).join(', ')}${unevaluated.count > 8 ? ', …' : ''}): give them a ` +
        'colour with edit_grape and this check starts seeing their wines.'
      : '';

    if (args.counts_only) {
      return ok(
        `${all.length} wine(s) whose stored type contradicts every grape on them.${caveat}`,
        { total: all.length, unevaluated_varieties: unevaluated }
      );
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
      `list is wrong on each — the check does not presume which.${caveat}`,
      { total: all.length, limit: args.limit, offset: args.offset, unevaluated_varieties: unevaluated, wines: rows }
    );
  },
});

// Grapes with no curated colour, restricted to the ones at least one
// published wine still references — the blind spot of the colour check.
async function colourlessVarietiesInUse() {
  const Grape = require('../../../models/Grape');
  const colourless = await Grape.find({ $or: [{ color: null }, { color: { $exists: false } }] }).select('name').lean();
  if (!colourless.length) return { count: 0, names: [] };
  const inUse = new Set(
    (await WineDefinition.distinct('grapes', { grapes: { $in: colourless.map((g) => g._id) }, nonWine: { $ne: true } }))
      .map(String)
  );
  const names = colourless.filter((g) => inUse.has(String(g._id))).map((g) => g.name).sort((a, b) => a.localeCompare(b));
  return { count: names.length, names: names.slice(0, 25) };
}

// The variety vocabulary the description audit grades against: curated rows,
// plus user mints a curator has since reviewed. An unreviewed mint is still
// just a string somebody typed.
const REVIEWED_VARIETY_FILTER = { $or: [{ createdByUser: { $ne: true } }, { reviewedAt: { $ne: null } }] };

// A row only a LABEL can settle must be settable aside, or it is
// re-researched every session — when a producer's range uses one name across
// a Sauvignon, a Lugana, a Ripasso and an Amarone, red + Sauvignon Blanc could
// be a mis-typed white or a clobbered grape list, and no amount of desk
// research decides which.
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

    const wine = await WineDefinition.findById(args.wine_id).select('name producer crossChecksCleared draft');
    if (!wine || wine.draft === true) return fail('not_found', 'No such wine.');
    if ((wine.crossChecksCleared || []).includes(COLOUR_RULE)) {
      return fail('conflict', 'That row is already set aside — restore_colour_conflict brings it back.');
    }

    // Re-detect rather than trust the caller: the row may have been FIXED since
    // the list was read, and setting aside a wine that no longer conflicts
    // would hide a clean record from a check it now passes.
    const { findGrapeColourConflict } = require('../../../utils/grapeColourCheck');
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
    const wine = await WineDefinition.findById(args.wine_id).select('name producer crossChecksCleared draft');
    if (!wine || wine.draft === true) return fail('not_found', 'No such wine.');
    if (!(wine.crossChecksCleared || []).includes(COLOUR_RULE)) {
      return fail('invalid_input', 'That row is not set aside.');
    }
    await WineDefinition.updateOne({ _id: wine._id }, { $pull: { crossChecksCleared: COLOUR_RULE } });
    logAudit(ctx.req, 'somm.colourConflict.restore', { type: 'wine', id: wine._id },
      { name: wine.name, producer: wine.producer, via: 'mcp' });
    return ok(`Back in the worklist: ${wine.producer} — ${wine.name}.`, { wine_id: String(wine._id), dismissed: false });
  },
});

// A deterministic rule that moves rows OUT
// of a queue is invisible by construction: the rows stop appearing anywhere,
// so a rule that is subtly wrong keeps being right as far as anyone can see.
// The condition for accepting the epistemic rule is that the moved rows
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
    'published without an owner-visible caveat. `note_doubts_cuvee_not_producer` fires when the ' +
    'doubt is scoped to the WINE NAME or a quoted other entity while the producer is named affirmatively — "La ' +
    'Libertad appears to be a label or line from Bodega Benegas" doubts the cuvée, not the estate; it declines ' +
    'whenever any clause doubts the producer itself, and lands clean, or on producerUnknown when the note also ' +
    'carries first-person doubt about the producer. This list exists so a rule that turns out to be wrong can be found ' +
    'and reversed as a set instead of re-derived — spot-check a sample, and if a row should not have moved, ' +
    'propose_wine_correction or set_wine_profile still work on it normally; and when the row is RIGHT — a ' +
    'documented estate the rule happened to move — review_held_profile with decision confirm records the placement ' +
    'and takes it off this list. A row a HUMAN judged carries ' +
    'suspectDecision instead and never appears here. One documented semantic: the tag records ' +
    'which rule FIRED under strongest-claim-first precedence, not which shape the note best fits — a note that ' +
    'textually asserts a producer can carry the epistemic tag when the assertion regex did not match it; the ' +
    'outcome is identical either way. A fourth tag, `appellation_has_geography`, is record-based rather than ' +
    'note-based: the wine carries an appellation that resolves to a curated entry with geography, so a knowable ' +
    'house stands behind whatever the producer string says.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    // Derived from the rule table itself, so a rule added to the downgrade
    // logic is filterable here the same day — a hand-kept list would leave
    // a new rule's rows counted but unreachable.
    rule: z.enum(Object.values(DOWNGRADE_RULES)).optional()
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

// Descriptions asserting
// geography on records whose place fields are deliberately null. The check
// grades by FRAME, not truth — a disclosure paragraph that names several
// regions in order to say the region is unknown must never be flagged as if
// it had asserted one. This is the published-row AUDIT surface; it deliberately does
// not share strictness with the enrichment-side notePlaceConflict blocker.
registerTool({
  name: 'list_ungrounded_descriptions',
  title: 'Sommelier: published descriptions claiming places the record does not carry',
  description:
    'Registry wines whose PUBLISHED AI description names a place or variety on a record that has NO region and NO ' +
    'appellation — so every such claim in the prose is ungrounded by construction. Each ungrounded claim is ' +
    'labelled kind: place | variety, so the two read apart at a glance. ' +
    'The producer\'s own name and the record\'s country are subtracted from claim spans ' +
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
    'descriptions are out of scope by construction. Records that HAVE a ' +
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
    const { gradeDescription } = require('../../../utils/descriptionGrounding');

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
    // (a field called "place" holding "Cabernet Franc" reads as a broken
    // grader to a first reader, though the extraction is correct).
    // Only varieties a curator has stood behind. A user-minted grape still
    // awaiting review is an unverified string, and one named after a flavour
    // ("Cherry", minted from a cherry wine) turns every "red
    // cherry" in the prose into a false variety claim that buries the real
    // ungrounded-place assertions this audit exists to surface.
    const Grape = require('../../../models/Grape');
    const grapeVocabulary = (await Grape.find(REVIEWED_VARIETY_FILTER).select('name').lean()).map((g) => g.name);

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
        // one a preposition introduces — "Cabernet Franc, Petit Verdot and
        // Merlot" is three claims, not one.
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
