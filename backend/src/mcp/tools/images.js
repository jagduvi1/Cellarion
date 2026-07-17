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
    'Confirm with the user which bottle before attaching. Reversible via undo_last.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId.describe('The bottle to attach the photo to (from search_bottles / add_bottle)'),
    image_url: z.string().url().optional().describe('https URL of the image (retailer/CDN product image)'),
    image_base64: z.string().max(MAX_BASE64_CHARS).optional().describe('Base64 image data (no data: prefix needed); alternative to image_url'),
    credit: z.string().max(200).optional().describe('Optional attribution/source note'),
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

    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
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
    const credit = args.credit ? String(args.credit).slice(0, 200) : null;
    const result = await ingestBottleImage({ buffer, userId: ctx.user.id, bottle, credit }, ctx.req);
    if (result.error) {
      // 4xx = the caller's image is bad (invalid_input); 5xx = a transient
      // infra fault → `unavailable` (MCP-audit M3: not the agent's cadence).
      return fail(result.error.status >= 500 ? 'unavailable' : 'invalid_input', result.error.message);
    }
    const image = result.image;
    logAudit(ctx.req, 'image.attach', { type: 'bottle', id: bottle._id, cellarId: bottle.cellar }, { via: 'mcp', imageId: String(image._id) });

    const envelope = {
      summary: `Attached a photo to vintage ${bottle.vintage} (background removal in progress)`,
      data: {
        image_id: image._id,
        bottle_id: bottle._id,
        status: image.status,
        source: args.image_url ? 'url' : 'upload',
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
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = {};
