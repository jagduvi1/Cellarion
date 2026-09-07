// attach_bottle_image (plan §3.18) — the parity gap a real user hit: adding a
// bottle over MCP but having no way to put its label photo on. Two input
// modes for a caller with no file upload:
//   - image_url: an https product/label image (e.g. the Systembolaget page's
//     image). Downloaded server-side through the SSRF guard.
//   - image_base64: raw bytes the caller already holds (a photo the user
//     showed their AI). Capped small so it fits an MCP JSON body.
// Both funnel through services/imageOps.ingestBottleImage — the SAME
// sanitise/persist/background-removal pipeline the web upload uses, so an
// EXIF-laden or malformed image is rejected identically on both surfaces.
const { z } = require('zod');
const { registerTool } = require('../registry');
const { ingestBottleImage } = require('../../services/imageOps');
const { safeFetchImage } = require('../../utils/safeImageFetch');
const { logAudit } = require('../../services/audit');
const { ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess } = require('../toolUtil');
const { logAction, replay } = require('../actionLedger');
const Bottle = require('../../models/Bottle');
const BottleImage = require('../../models/BottleImage');

// Base64 payloads ride the JSON body (the /api/mcp limit is 2MB). ~1.5M base64
// chars ≈ ~1.1MB image — plenty for a label; larger photos must come by URL.
const MAX_BASE64_CHARS = 1_500_000;

registerTool({
  name: 'attach_bottle_image',
  title: 'Attach a label/bottle photo',
  description:
    'Adds a label or bottle photo to one of the user\'s bottles, from an image URL (https) or base64 image data ' +
    '(JPEG/PNG/WebP). Use image_url for a product image you found on the web (e.g. a retailer\'s wine page); use ' +
    'image_base64 for a photo the user shared directly. The image is background-removed automatically after upload. ' +
    'Attach ONCE per wine: the photo shows on ALL the user\'s bottles of that wine, so never repeat the same photo ' +
    'for duplicate bottles — check get_bottle → photos first, and the response says how many photos the wine ' +
    'already had from the user (photos_before) and on how many bottles it now shows (shows_on_bottles). Pass wine_id ' +
    'instead of bottle_id when you only know the wine; the photo goes on the user\'s newest active bottle of it. ' +
    'Confirm with the user before attaching. Reversible via undo_last.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId.optional().describe('The bottle to attach the photo to (from search_bottles / add_bottle)'),
    wine_id: objectId.optional().describe('Alternative to bottle_id: the registry wine — the photo goes on your newest active bottle of it (it shows on all of them anyway)'),
    image_url: z.string().url().optional().describe('https URL of the image (retailer/CDN product image)'),
    image_base64: z.string().max(MAX_BASE64_CHARS).optional().describe('Base64 image data (no data: prefix needed); alternative to image_url'),
    credit: z.string().max(200).optional().describe('Optional attribution/source note — admin accounts only; silently ignored for regular users (matches the web app)'),
    keep_background: z.boolean().optional().describe('Skip background removal. Set it for a photo of just the label, a retailer product shot, or anything that is not a whole bottle on a plain background — background removal expects a bottle and cuts everything else away. Default false.'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'attach_bottle_image');
    if (replayed) return replayed;

    if (!args.image_url && !args.image_base64) {
      return fail('invalid_input', 'Provide image_url (https) or image_base64.');
    }
    if (args.image_url && args.image_base64) {
      return fail('invalid_input', 'Provide image_url OR image_base64, not both.');
    }

    if (!args.bottle_id && !args.wine_id) {
      return fail('invalid_input', 'Provide bottle_id (from search_bottles) or wine_id (the registry wine — the photo then goes on your newest active bottle of it).');
    }
    let bottleId = args.bottle_id;
    if (!bottleId) {
      // wine_id: the effect is per wine, so any of the user's bottles will do —
      // the newest active one, so the photo lands where the user is looking.
      const own = await Bottle.findOne({ user: ctx.user.id, wineDefinition: args.wine_id, status: 'active' })
        .sort({ createdAt: -1 }).select('_id').lean();
      if (!own) return fail('not_found', 'You have no active bottle of that wine. Add one first (resolve_wine → add_bottle), then attach the photo.');
      bottleId = String(own._id);
    }
    const access = await resolveBottleAccess(ctx.user.id, bottleId, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;

    // Resolve the bytes. Failures here are the caller's fault (bad URL, too
    // big, not an image) → invalid_input with the guard's own message.
    let buffer;
    if (args.image_url) {
      try {
        const fetched = await safeFetchImage(args.image_url);
        buffer = fetched.buffer;
      } catch (err) {
        return fail('invalid_input', `Could not fetch that image: ${err.message}`);
      }
    } else {
      // Accept a bare base64 string or a data: URL — strip the prefix if present.
      const b64 = String(args.image_base64).replace(/^data:image\/[a-z+]+;base64,/i, '');
      buffer = Buffer.from(b64, 'base64');
      if (buffer.length === 0) return fail('invalid_input', 'image_base64 did not decode to any bytes.');
    }

    // Shared pipeline: validate + strip metadata + persist + background-remove.
    // wineDefinitionId makes the photo WINE-linked exactly like the web upload
    // (routes/images.js): it then shows on all the user's bottles of this wine
    // and enters the registry-image review pipeline. Without it the photo was
    // stranded on the single bottle — the "attached 5 times for 5 identical
    // bottles" launch-day report.
    // credit is gated + sanitised INSIDE the shared pipeline (admin-only,
    // stripHtml) — same rule as the web upload route, one implementation.
    const wineDefinitionId = bottle.wineDefinition
      ? String(bottle.wineDefinition._id || bottle.wineDefinition)
      : null;
    // What the user already had, so a duplicate is visible in the answer
    // (support ticket 2026-09-06: "attach once per wine" could not be honoured
    // with no way to look). Counts are a courtesy — never fatal.
    const count = (p) => Promise.resolve(p).then((n) => (Number.isFinite(n) ? n : null)).catch(() => null);
    const photosBefore = await count(BottleImage.countDocuments({
      uploadedBy: ctx.user.id, status: { $ne: 'rejected' }, kind: { $ne: 'label-scan' },
      $or: [{ bottle: bottle._id }, ...(wineDefinitionId ? [{ wineDefinition: wineDefinitionId }] : [])],
    }));
    const result = await ingestBottleImage({
      buffer, userId: ctx.user.id, userRoles: ctx.user.roles, bottle, wineDefinitionId, credit: args.credit || null,
      keepBackground: args.keep_background === true,
    }, ctx.req);
    if (result.error) {
      // 4xx = the caller's image is bad (invalid_input); 5xx = a transient
      // infra fault → `unavailable` (MCP-audit M3: not the agent's cadence).
      return fail(result.error.status >= 500 ? 'unavailable' : 'invalid_input', result.error.message);
    }
    const image = result.image;
    logAudit(ctx.req, 'image.attach', { type: 'bottle', id: bottle._id, cellarId: bottle.cellar }, { via: 'mcp', imageId: String(image._id) });

    const showsOn = wineDefinitionId
      ? await count(Bottle.countDocuments({ user: ctx.user.id, wineDefinition: wineDefinitionId, status: 'active' }))
      : 1;
    // 'processed' = the background was kept, so nothing runs; otherwise the
    // row waits for background removal ('uploaded' → queued).
    const state = image.status === 'processed' ? 'awaiting_review' : 'queued';
    const warnings = photosBefore > 0
      ? [`This wine already had ${photosBefore} photo(s) from you — if this one duplicates it, undo_last removes it.`]
      : [];
    const envelope = {
      summary: `Attached a photo to vintage ${bottle.vintage}` +
        (wineDefinitionId ? ` — it shows on ${showsOn == null ? 'all' : showsOn} of your bottle(s) of this wine` : '') +
        (state === 'queued' ? ' (background removal in progress)' : ' (background kept, awaiting review)'),
      data: {
        image_id: image._id,
        bottle_id: bottle._id,
        wine_id: wineDefinitionId,
        status: image.status,
        state,
        source: args.image_url ? 'url' : 'upload',
        shows_on_all_bottles_of_wine: !!wineDefinitionId,
        shows_on_bottles: showsOn,
        photos_before: photosBefore,
        check: 'get_bottle → photos lists every photo of this bottle with its state',
        undo: 'undo_last removes the photo',
      },
    };
    await logAction(ctx, {
      tool: 'attach_bottle_image',
      action: 'attach_image',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { imageId: String(image._id) },
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data, warnings.length ? { warnings } : undefined);
  },
});

module.exports = {};
