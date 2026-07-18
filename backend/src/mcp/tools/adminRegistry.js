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
        { buffer, wineDefinitionId: wineDoc._id, credit, userId: ctx.user.id }, ctx.req
      );
      if (result.error) {
        return fail(result.error.status >= 500 ? 'unavailable' : 'invalid_input',
          `Wine ${created ? 'created' : 'resolved'} (wine_id ${wineDoc._id}) but the image failed: ${result.error.message}`);
      }
      logAudit(ctx.req, 'admin.wine.image.set',
        { type: 'wine', id: wineDoc._id },
        { via: 'mcp', imageId: String(result.image._id), credit });
      imageInfo = { image_id: result.image._id, status: result.image.status, credit };
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
