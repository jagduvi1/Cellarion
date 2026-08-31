// Admin registry curation over MCP (Johan's launch-day request): an ADMIN's
// connected AI can add a wine to the SHARED registry directly — with an
// official image and its credit — instead of bouncing through the web admin.
//
// Role gating is STRUCTURAL (requireRole, same pattern as tools/somm.js): for
// any non-admin connection this tool is UNREGISTERED, not hidden. Creation
// still runs through findOrCreateWine — the same #674-hardened dedup
// chokepoint as everything else — so an admin's AI gets "did you mean?"
// candidates rather than minting duplicates; the image path shares
// attachOfficialWineImage with the admin REST route (no drift).
//
// Registry actions are NOT personal-cellar actions: they are audited
// (wine.create / admin.wine.image.set) but deliberately NOT written to the
// personal undo ledger — undo_last cannot unwind a shared-registry change;
// admins manage those in Admin → Wines.
const { z } = require('zod');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const { ok, fail, wineSummary } = require('../toolUtil');
const { safeFetchImage } = require('../../utils/safeImageFetch');

const MAX_BASE64_CHARS = 1_500_000; // same budget as attach_bottle_image

registerTool({
  name: 'admin_add_registry_wine',
  title: 'ADMIN: add a wine to the shared registry (with official image)',
  description:
    'ADMIN ONLY. Adds a wine to the SHARED registry that every Cellarion user searches — not to a personal cellar. ' +
    'Runs the same duplicate detection as every other surface: if similar wines exist you get candidates back; ' +
    'call again with confirm_create:true ONLY after confirming it is genuinely different. Optionally sets the ' +
    'wine\'s official public image in the same call (image_url https or image_base64) with a credit/attribution — ' +
    'the image is background-removed and replaces any prior official photo. NOT reversible via undo_last: registry ' +
    'changes are managed in Admin → Wines.',
  scope: 'write',
  requireRole: ['admin'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    name: z.string().trim().min(1).max(200).describe('Wine name WITHOUT the producer in it'),
    producer: z.string().trim().min(1).max(200),
    country: z.string().trim().min(1).max(200).describe('Country name (required)'),
    region: z.string().max(200).optional(),
    appellation: z.string().max(200).optional(),
    type: z.enum(['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified']).describe('Required: defaulting silently would mint wrong-type registry entries'),
    grapes: z.array(z.string().max(200)).max(10).optional(),
    confirm_create: z.boolean().optional().describe('Set true ONLY after reviewing returned candidates and confirming this is a different wine'),
    image_url: z.string().url().optional().describe('https URL of the official image (retailer/producer product photo)'),
    image_base64: z.string().max(MAX_BASE64_CHARS).optional().describe('Base64 image bytes; alternative to image_url'),
    image_credit: z.string().max(200).optional().describe('Attribution shown with the image (e.g. "Photo: Systembolaget")'),
    existing_wine_id: z.string().optional().describe('Skip creation: set the official image on this EXISTING registry wine instead'),
  },
  handler: async (args, ctx) => {
    if (args.image_url && args.image_base64) {
      return fail('invalid_input', 'Provide image_url OR image_base64, not both.');
    }

    // Resolve or create the wine.
    let wineDoc;
    let created = false;
    if (args.existing_wine_id) {
      if (!isValidId(args.existing_wine_id)) return fail('invalid_input', 'existing_wine_id must be a 24-hex Mongo id.');
      wineDoc = await WineDefinition.findById(args.existing_wine_id).populate(['country', 'region', 'grapes']);
      if (!wineDoc) return fail('not_found', 'No registry wine with that id.');
    } else {
      const { findOrCreateWine } = require('../../services/findOrCreateWine');
      let result;
      try {
        // The appellation is handed over RAW on purpose. findOrCreateWine is
        // the mint chokepoint and already tier-strips AND resolves it against
        // the curated registry before keying and storing; pre-canonicalizing
        // here would only add a second, driftable copy of that rule (the
        // admin REST create has to do it itself precisely because it writes
        // the WineDefinition directly instead of coming through here).
        result = await findOrCreateWine({
          name: args.name,
          producer: args.producer,
          country: args.country,
          region: args.region,
          appellation: args.appellation,
          type: args.type,
          grapes: args.grapes,
        }, ctx.user.id, { confirmCreate: !!args.confirm_create, skipSiblingMatch: false, createdVia: 'mcp' });
      } catch (err) {
        if (err?.status === 400) return fail('invalid_input', err.message);
        throw err;
      }
      if (!result.wine && result.candidates?.length) {
        return fail('conflict',
          'Very similar wines already exist — use existing_wine_id with one of these to just set its image, or call ' +
          'again with confirm_create:true ONLY if it is genuinely different: ' +
          result.candidates.map((c) => `${c.wine.name} — ${c.wine.producer} (wine_id ${c.wine._id}, score ${c.score})`).join('; '));
      }
      wineDoc = result.wine;
      created = !!result.created;
      if (created) {
        logAudit(ctx.req, 'wine.create',
          { type: 'wine', id: wineDoc._id },
          { via: 'mcp', admin: true, name: wineDoc.name, producer: wineDoc.producer });
      }
    }

    // Optional official image, shared implementation with the admin REST route.
    let imageInfo = null;
    if (args.image_url || args.image_base64) {
      let buffer;
      if (args.image_url) {
        try {
          buffer = (await safeFetchImage(args.image_url)).buffer;
        } catch (err) {
          return fail('invalid_input', `Wine ${created ? 'created' : 'resolved'} (wine_id ${wineDoc._id}) but the image could not be fetched: ${err.message}`);
        }
      } else {
        const b64 = String(args.image_base64).replace(/^data:image\/[a-z+]+;base64,/i, '');
        buffer = Buffer.from(b64, 'base64');
        if (buffer.length === 0) return fail('invalid_input', `Wine ${created ? 'created' : 'resolved'} (wine_id ${wineDoc._id}) but image_base64 did not decode to any bytes.`);
      }
      const { attachOfficialWineImage } = require('../../services/imageOps');
      const credit = args.image_credit ? String(args.image_credit).trim() : null;
      const result = await attachOfficialWineImage(
        { buffer, wineDefinitionId: wineDoc._id, credit, userId: ctx.user.id, userRoles: ctx.user.roles }, ctx.req
      );
      if (result.error) {
        return fail(result.error.status >= 500 ? 'unavailable' : 'invalid_input',
          `Wine ${created ? 'created' : 'resolved'} (wine_id ${wineDoc._id}) but the image failed: ${result.error.message}`);
      }
      // Report the credit the shared gate actually STORED (HTML-stripped),
      // not the raw input — audit and caller see the truth.
      const storedCredit = result.image.credit ?? null;
      logAudit(ctx.req, 'admin.wine.image.set',
        { type: 'wine', id: wineDoc._id },
        { via: 'mcp', imageId: String(result.image._id), credit: storedCredit });
      imageInfo = { image_id: result.image._id, status: result.image.status, credit: storedCredit };
    }

    return ok(
      `${created ? 'Created registry wine' : 'Registry wine already existed'}: ${wineDoc.name} — ${wineDoc.producer}` +
      `${imageInfo ? ' (official image set, background removal in progress)' : ''}`,
      {
        wine: wineSummary(wineDoc),
        wine_id: wineDoc._id,
        created,
        ...(imageInfo ? { official_image: imageInfo } : {}),
        note: 'Registry-level change: audited, managed in Admin → Wines, not undoable via undo_last.',
      }
    );
  },
});

module.exports = {};

// ── Taxonomy review queues (strategy 2026-07-29 R2/R3) ───────────────────────
// The same queues as Admin → Taxonomy, so an admin can run a review session
// from chat: list → judge → approve/promote. Same shared service as the REST
// routes (services/taxonomyReview.js) — the two surfaces cannot drift. Same
// no-undo-ledger stance as admin_add_registry_wine: shared-registry changes
// are audited, not personally undoable.

registerTool({
  name: 'list_region_review_queue',
  title: 'ADMIN: regions minted by users, awaiting review',
  description:
    'ADMIN ONLY. Lists regions that were auto-created by a user adding a wine (label scan, add-bottle, import) and ' +
    'that no admin has reviewed yet, newest first, with wine counts. A 1-wine region is usually a typo; judge each ' +
    'against the wine(s) that carry it, then approve_region the real ones. Typos/duplicates are merged in ' +
    'Admin → Taxonomy (merge is deliberately not exposed over MCP — it rewrites every referencing wine).',
  scope: 'read',
  requireRole: ['admin'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(30).describe('Newest first; the backlog can grow between reviews'),
  },
  handler: async (args, _ctx) => {
    const { listPendingRegions } = require('../../services/taxonomyReview');
    const all = await listPendingRegions();
    const items = all.slice(0, args.limit || 30);
    return ok(`${all.length} region(s) awaiting review (showing ${items.length})`, items.map(r => ({
      region_id: r._id,
      name: r.name,
      country: r.country,
      wine_count: r.wineCount,
      created_at: r.createdAt,
    })));
  },
});

registerTool({
  name: 'approve_region',
  title: 'ADMIN: approve a user-minted region',
  description:
    'ADMIN ONLY. Marks a user-minted region as reviewed (clears its queue flag). Approve ONLY after judging it is a ' +
    'real wine region with the right spelling — for a typo or duplicate, do NOT approve; merge it in Admin → ' +
    'Taxonomy instead. Not reversible via undo_last (audited admin action).',
  scope: 'write',
  requireRole: ['admin'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    region_id: z.string().describe('From list_region_review_queue'),
  },
  handler: async (args, ctx) => {
    if (!isValidId(args.region_id)) return fail('invalid_input', 'region_id must be a 24-hex Mongo id.');
    const Region = require('../../models/Region');
    const region = await Region.findById(args.region_id);
    if (!region) return fail('not_found', 'No region with that id.');
    if (region.reviewedAt) return ok(`"${region.name}" was already reviewed — nothing to do.`, { region_id: region._id, already: true });
    // Stamp the review; never clear createdByUser, which records where the

    // document came from and stays true forever.

    region.reviewedAt = new Date();

    region.reviewedBy = ctx.user?.id || null;
    await region.save();
    // Same audit action as the REST approve — the two surfaces audit identically.
    logAudit(ctx.req, 'admin.taxonomy.approveRegion',
      { type: 'region', id: region._id },
      { name: region.name, via: 'mcp' });
    return ok(`Approved region "${region.name}".`, { region_id: region._id, name: region.name });
  },
});

registerTool({
  name: 'list_unmatched_appellations',
  title: 'ADMIN: appellation strings no taxonomy entry covers',
  description:
    'ADMIN ONLY. Wines store appellations as free text; this lists every distinct normalized string that no curated ' +
    'Appellation entry (name or synonym) covers, with the majority display spelling, wine count and suggested ' +
    'country/region. Promote the real ones with promote_appellation; dismiss the ones that are NOT appellations ' +
    'with dismiss_appellation — dismissed strings stay out of this queue (include_dismissed:true shows them too). ' +
    'Rare/new appellations are normal here; users are never blocked by this queue.',
  scope: 'read',
  requireRole: ['admin'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(30).describe('Largest-first; the long tail is mostly 1-wine oddities'),
    include_dismissed: z.boolean().optional().describe('Also return the dismissed strings (as a separate `dismissed` array) — needed to pick a restore_appellation target'),
  },
  handler: async (args, _ctx) => {
    const { listUnmatchedAppellations, listDismissedAppellations } = require('../../services/taxonomyReview');
    const items = await listUnmatchedAppellations();
    const page = items.slice(0, args.limit || 30);
    const open = page.map(i => ({
      name: i.name,
      wine_count: i.wineCount,
      suggested_country: i.countryName,
      suggested_country_id: i.countryId,
      suggested_region: i.regionName,
      suggested_region_id: i.regionId,
    }));
    if (!args.include_dismissed) {
      return ok(`${items.length} unmatched appellation string(s) (showing ${page.length}, largest first)`, open);
    }
    const dismissed = await listDismissedAppellations();
    return ok(
      `${items.length} unmatched appellation string(s) (showing ${page.length}, largest first) + ${dismissed.length} dismissed`,
      { open, dismissed: dismissed.map(d => ({ name: d.name, reason: d.reason, dismissed_by: d.dismissedBy, dismissed_at: d.dismissedAt })) }
    );
  },
});

registerTool({
  name: 'promote_appellation',
  title: 'ADMIN: promote an appellation into the curated taxonomy',
  description:
    'ADMIN ONLY. Creates a curated Appellation entry — from then on, new wines typed/scanned with this appellation ' +
    '(or any synonym) adopt the canonical spelling automatically. Use the suggested country from ' +
    'list_unmatched_appellations unless you know better; the NAME is what users will see, so fix the spelling ' +
    'here if the majority form is itself a typo. Not reversible via undo_last (delete in Admin → Taxonomy).',
  scope: 'write',
  requireRole: ['admin'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    name: z.string().trim().min(1).max(200).describe('Canonical display spelling'),
    country_id: z.string().describe('From list_unmatched_appellations suggested_country_id, or the admin taxonomy'),
    region_id: z.string().optional().describe('Optional; must belong to the same country'),
    synonyms: z.array(z.string().max(200)).max(10).optional().describe('Alternative spellings that should resolve to this entry'),
  },
  handler: async (args, ctx) => {
    if (!isValidId(args.country_id)) return fail('invalid_input', 'country_id must be a 24-hex Mongo id.');
    if (args.region_id && !isValidId(args.region_id)) return fail('invalid_input', 'region_id must be a 24-hex Mongo id.');
    // The schema's "must belong to the same country" was documentation, not
    // validation (code audit 2026-07-30) — enforce it via the shared guard so
    // this surface and the REST twin cannot drift.
    const { appellationRefsError } = require('../../services/taxonomyReview');
    const refsError = await appellationRefsError(args.country_id, args.region_id);
    if (refsError) return fail('invalid_input', refsError);
    const Appellation = require('../../models/Appellation');
    const { normalizeAppellationKey } = require('../../utils/normalize');
    const appellation = new Appellation({
      name: args.name,
      normalizedName: normalizeAppellationKey(args.name),
      country: args.country_id,
      region: args.region_id || null,
      synonyms: args.synonyms?.length ? args.synonyms : undefined,
      createdBy: ctx.user.id,
    });
    try {
      await appellation.save();
    } catch (err) {
      if (err.code === 11000) return fail('conflict', 'An appellation with that name already exists in that country.');
      throw err;
    }
    logAudit(ctx.req, 'admin.taxonomy.create',
      { type: 'appellation', id: appellation._id },
      { name: appellation.name, via: 'mcp' });
    return ok(`Appellation "${appellation.name}" is now curated — new wines will adopt this spelling.`, {
      appellation_id: appellation._id,
      name: appellation.name,
    });
  },
});

registerTool({
  name: 'dismiss_appellation',
  title: 'ADMIN: dismiss an unmatched appellation string for good',
  description:
    'ADMIN ONLY. Marks an unmatched appellation string as reviewed and REJECTED — it leaves ' +
    'list_unmatched_appellations and stays out until restore_appellation lifts the dismissal. Spelling variants ' +
    'that fold to the same string go quiet with it. Use for strings that are NOT appellations (quality tiers like ' +
    '"Qualitätswein", fantasy names, label slogans); for a real appellation use promote_appellation instead. The ' +
    'wines keep their free-text value either way — this only silences the review queue. Same terminal-state ' +
    'pattern as reject_price_request (ticket 6a842d5e).',
  scope: 'write',
  requireRole: ['admin'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    name: z.string().trim().min(1).max(200).describe('The string exactly as list_unmatched_appellations shows it'),
    reason: z.string().min(5).max(500).describe('Why it is not an appellation — kept as the durable review record'),
  },
  handler: async (args, ctx) => {
    const { dismissUnmatchedAppellation } = require('../../services/taxonomyReview');
    const result = await dismissUnmatchedAppellation({ name: args.name, reason: args.reason, userId: ctx.user.id });
    if (result.error) return fail('invalid_input', result.error);
    // Same audit action string as the REST dismiss — the two surfaces audit
    // identically. No target ObjectId: the subject is a string key.
    logAudit(ctx.req, 'admin.taxonomy.appellationDismiss', { type: 'appellation' },
      { key: result.key, name: result.name, reason: args.reason, already: !result.created, via: 'mcp' });
    return ok(
      result.created
        ? `Dismissed "${result.name}" — it will not resurface in the unmatched queue. restore_appellation reverses this.`
        : `"${result.name}" was already dismissed — nothing to do.`,
      { key: result.key, name: result.name, already: !result.created }
    );
  },
});

registerTool({
  name: 'restore_appellation',
  title: 'ADMIN: lift an appellation dismissal',
  description:
    'ADMIN ONLY. Removes a dismissal recorded by dismiss_appellation, so the string re-enters ' +
    'list_unmatched_appellations while wines still carry it. Find dismissed strings via ' +
    'list_unmatched_appellations with include_dismissed:true.',
  scope: 'write',
  requireRole: ['admin'],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    name: z.string().trim().min(1).max(200).describe('The dismissed string (any spelling that folds to it works)'),
  },
  handler: async (args, ctx) => {
    const { restoreDismissedAppellation } = require('../../services/taxonomyReview');
    const result = await restoreDismissedAppellation(args.name);
    if (result.error) return fail('invalid_input', result.error);
    if (!result.restored) return fail('not_found', 'No dismissal recorded for that string — list_unmatched_appellations include_dismissed:true shows what is dismissed.');
    logAudit(ctx.req, 'admin.taxonomy.appellationRestore', { type: 'appellation' },
      { key: result.key, via: 'mcp' });
    return ok(`Dismissal lifted — "${args.name}" can appear in the unmatched queue again.`, { key: result.key });
  },
});

module.exports = {};
