// Sommelier MCP tools for the PHOTO REVIEW queue (list_image_queue /
// review_image): the photos members upload on their bottles wait for a curator
// before they join the wine's public gallery, and reported photos wait for an
// answer. Until now only an admin could work this queue, on the web; a curator
// routine can now do it from the connector.
//
// Role gating is STRUCTURAL (requireRole, same as tools/somm.js) with a re-check
// inside each handler. The REST twin, /api/admin/images, stays admin-only: that
// route backs the admin web page, while MCP is the sommelier's surface — the
// same split as review_registry_data. Every decision runs
// services/imageModerationOps, the code the admin page runs, so what is
// published, what the uploader is told and what is audited cannot drift.
//
// PRIVACY: a photo in this queue is somebody's upload that is not public yet.
// It leaves the platform for the curator's model provider for ONE purpose —
// deciding whether it is published — so:
//   - the image sent is the processed render (background removed), i.e. the
//     file that would be published, never the raw frame; a "keep background"
//     upload is the uploader's own choice of file;
//   - the uploader is never named: a pseudonymous uploader_ref groups one
//     person's photos, and nothing else about them crosses this surface;
//   - every read leaves an audit row naming the image ids (never the bytes),
//     like the curation reads of label scans (audit 2026-09 M03-4);
//   - label scans are never listed (private curation evidence, audit L-6), and
//     photos with no bottle and no wine — uploads abandoned before the bottle
//     was saved — are left to the 30-day sweep (services/scanImageRetentionJob).
const crypto = require('crypto');
const mongoose = require('mongoose');
const { z } = require('zod');
const BottleImage = require('../../models/BottleImage');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
const { ok, fail, objectId } = require('../toolUtil');
const { logAction } = require('../actionLedger');
const { logAudit } = require('../../services/audit');
const { renderImage } = require('../../services/photoBytes');
const { photoVintage } = require('../../utils/imageVintage');
const {
  REJECT_REASON_MAX,
  approveImage,
  rejectImage,
  setOfficialImage,
  setImageVisibility,
  dismissImageReport,
} = require('../../services/imageModerationOps');

const SOMM_ROLES = ['somm', 'admin'];
const PAGE_MAX = 8;
const IMAGE_MAX_EDGE = 1024;
const IMAGE_TOTAL_CAP_BYTES = 4 * 1024 * 1024;
const NOT_SCAN = { $ne: 'label-scan' };

// The queue the admin page opens on (status 'processed': background removal
// done, nobody has decided yet), minus the abandoned uploads.
const PENDING_FILTER = {
  kind: NOT_SCAN,
  status: 'processed',
  $or: [{ bottle: { $ne: null } }, { wineDefinition: { $ne: null } }],
};
const ORPHAN_FILTER = { kind: NOT_SCAN, status: 'processed', bottle: null, wineDefinition: null };
const REPORTED_FILTER = { kind: NOT_SCAN, reportedAt: { $ne: null }, status: { $ne: 'rejected' } };

function requireSomm(ctx) {
  const roles = ctx.user?.roles || [];
  return SOMM_ROLES.some((r) => roles.includes(r))
    ? null
    : fail('forbidden_scope', 'This tool needs the sommelier (or admin) role.');
}

// Stable across calls, so "the same person uploaded these" survives paging;
// not a user id, and nothing on this surface maps it back to one.
const uploaderRef = (id) => crypto.createHash('sha256').update(`image-queue|${id}`).digest('hex').slice(0, 8);

const wineLabel = (w) => (w ? [w.producer, w.name].filter(Boolean).join(' — ') : null);
const idStr = (v) => (v == null ? null : String(v));
const oid = (id) => new mongoose.Types.ObjectId(id);

/** A photo this tool may decide on: waiting in the queue, or reported. */
function reviewState(img) {
  if (!img || img.kind === 'label-scan') return null;
  if (!img.bottle && !img.wineDefinition) return null;
  if (img.status === 'processed') return 'pending';
  if (img.reportedAt && img.status === 'approved') return 'reported';
  return null;
}

registerTool({
  name: 'list_image_queue',
  title: 'Sommelier: photos waiting for review',
  description:
    'Lists the bottle photos members uploaded that wait for a curator before they join the wine\'s public gallery ' +
    '(queue "pending", oldest first), or the published photos somebody REPORTED (queue "reported", oldest report ' +
    'first). Each photo comes back as an IMAGE you can look at — the file that would be published (background ' +
    'removed, unless the uploader kept it) — preceded by a caption naming the wine. Per photo you also get: the wine ' +
    'and vintage it belongs to; wine_main_picture ("none" = the wine has no picture yet, "this_photo", or "other" — ' +
    'see the current one with get_photo wine_id); how many photos the wine already publishes; same_bottle_in_queue ' +
    '(other photos of the SAME bottle waiting, typically a front and a back label — judge them together); ' +
    'uploader_ref, a pseudonym that groups one person\'s photos (never who they are); same_file (only known for ' +
    'imported photos: the same file on other photos/wines — a logo or a shop picture used for many wines); and for ' +
    'reported photos the reasons given. Decide each one with review_image. These are members\' unpublished photos, ' +
    'shown for this decision only: do not describe, store or reuse them for anything else. Label scans are never in ' +
    'this queue, and uploads abandoned before their bottle was saved are left to the automatic 30-day cleanup.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    queue: z.enum(['pending', 'reported']).default('pending')
      .describe('"pending" = new uploads waiting for a decision; "reported" = published photos a member reported'),
    limit: z.number().int().min(1).max(PAGE_MAX).default(5)
      .describe(`Photos per page (max ${PAGE_MAX} — each one is an image)`),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const queue = args.queue || 'pending';
    const limit = args.limit || 5;
    const offset = args.offset || 0;
    const filter = queue === 'reported' ? REPORTED_FILTER : PENDING_FILTER;

    const [rows, total, orphans] = await Promise.all([
      BottleImage.find(filter)
        .sort(queue === 'reported' ? { reportedAt: 1 } : { createdAt: 1 })
        .skip(offset)
        .limit(limit)
        .select('_id bottle wineDefinition uploadedBy processedUrl originalUrl status visibility keepBackground credit assignedToWine vintage side contentHash reports reportedAt createdAt')
        .lean(),
      BottleImage.countDocuments(filter),
      queue === 'pending' ? BottleImage.countDocuments(ORPHAN_FILTER) : Promise.resolve(0),
    ]);

    if (rows.length === 0) {
      return ok(
        queue === 'reported' ? 'No reported photos are waiting' : `The photo queue is empty${orphans ? ` (${orphans} abandoned upload(s) wait for the automatic cleanup)` : ''}`,
        { queue, total, ...(queue === 'pending' ? { abandoned_uploads: orphans } : {}) },
        { page: { limit, offset, total } }
      );
    }

    // Context for the page, in a fixed number of queries.
    const bottleIds = [...new Set(rows.map((r) => idStr(r.bottle)).filter(Boolean))];
    const bottles = bottleIds.length
      ? await Bottle.find({ _id: { $in: bottleIds } }).select('_id wineDefinition vintage').lean()
      : [];
    const bottleMap = new Map(bottles.map((b) => [idStr(b._id), b]));
    const wineIdOf = (r) => idStr(r.wineDefinition) || idStr(bottleMap.get(idStr(r.bottle))?.wineDefinition);
    const wineIds = [...new Set(rows.map(wineIdOf).filter(Boolean))];
    const uploaderIds = [...new Set(rows.map((r) => idStr(r.uploadedBy)).filter(Boolean))];
    const hashes = [...new Set(rows.map((r) => r.contentHash).filter(Boolean))];

    const [wines, mains, published, siblings, uploaderCounts, sameFile] = await Promise.all([
      wineIds.length ? WineDefinition.find({ _id: { $in: wineIds } }).select('_id name producer type image').lean() : [],
      wineIds.length ? BottleImage.find({ wineDefinition: { $in: wineIds }, assignedToWine: true }).select('_id wineDefinition').lean() : [],
      wineIds.length ? BottleImage.aggregate([
        { $match: { wineDefinition: { $in: wineIds.map(oid) }, status: 'approved', visibility: 'public', kind: NOT_SCAN } },
        { $group: { _id: '$wineDefinition', n: { $sum: 1 } } },
      ]) : [],
      bottleIds.length ? BottleImage.find({ bottle: { $in: bottleIds }, status: 'processed', kind: NOT_SCAN }).select('_id bottle').lean() : [],
      uploaderIds.length ? BottleImage.aggregate([
        { $match: { ...PENDING_FILTER, uploadedBy: { $in: uploaderIds.map(oid) } } },
        { $group: { _id: '$uploadedBy', n: { $sum: 1 } } },
      ]) : [],
      hashes.length ? BottleImage.aggregate([
        { $match: { contentHash: { $in: hashes }, status: { $ne: 'rejected' }, kind: NOT_SCAN } },
        { $group: { _id: '$contentHash', photos: { $sum: 1 }, wines: { $addToSet: '$wineDefinition' } } },
      ]) : [],
    ]);
    const wineMap = new Map(wines.map((w) => [idStr(w._id), w]));
    const mainMap = new Map(mains.map((m) => [idStr(m.wineDefinition), idStr(m._id)]));
    const publishedMap = new Map(published.map((p) => [idStr(p._id), p.n]));
    const uploaderMap = new Map(uploaderCounts.map((u) => [idStr(u._id), u.n]));
    const sameFileMap = new Map(sameFile.map((s) => [s._id, s]));
    const siblingMap = new Map();
    for (const s of siblings) {
      const key = idStr(s.bottle);
      if (!siblingMap.has(key)) siblingMap.set(key, []);
      siblingMap.get(key).push(idStr(s._id));
    }

    const blocks = [];
    const items = [];
    let totalBytes = 0;
    let truncated = false;
    for (const r of rows) {
      const id = idStr(r._id);
      const wineId = wineIdOf(r);
      const wine = wineId ? wineMap.get(wineId) : null;
      const vintage = photoVintage(r.vintage) || photoVintage(bottleMap.get(idStr(r.bottle))?.vintage) || null;
      let mainPicture = 'none';
      if (wine && wine.image) mainPicture = r.assignedToWine || mainMap.get(wineId) === id ? 'this_photo' : 'other';
      const sf = r.contentHash ? sameFileMap.get(r.contentHash) : null;

      const item = {
        image_id: id,
        wine: wine ? { wine_id: idStr(wine._id), producer: wine.producer || null, name: wine.name, type: wine.type || null } : null,
        vintage,
        wine_main_picture: mainPicture,
        wine_published_photos: wineId ? (publishedMap.get(wineId) || 0) : 0,
        same_bottle_in_queue: r.bottle ? (siblingMap.get(idStr(r.bottle)) || []).filter((x) => x !== id) : [],
        uploader_ref: uploaderRef(r.uploadedBy),
        uploader_photos_in_queue: uploaderMap.get(idStr(r.uploadedBy)) || 0,
        background_kept: r.keepBackground === true,
        uploaded_at: r.createdAt,
        ...(r.credit ? { credit: r.credit } : {}),
        ...(r.side === 'back' ? { side: 'back' } : {}),
        ...(sf && sf.photos > 1 ? { same_file: { other_photos: sf.photos - 1, wines: sf.wines.filter(Boolean).length } } : {}),
        ...(queue === 'reported' ? {
          visibility: r.visibility,
          reports: (r.reports || []).map((rep) => ({ reason: rep.reason, detail: rep.detail || null, at: rep.createdAt })),
        } : {}),
        image_included: false,
      };

      // The file that would be published: the processed render, else the
      // kept original of a keep-background upload.
      const url = r.processedUrl || r.originalUrl;
      if (!truncated && url && typeof url === 'string' && url.startsWith('/api/uploads/')) {
        try {
          const rendered = await renderImage(url, { maxEdge: IMAGE_MAX_EDGE });
          if (rendered) {
            if (totalBytes + rendered.bytes > IMAGE_TOTAL_CAP_BYTES) {
              truncated = true;
            } else {
              totalBytes += rendered.bytes;
              const reported = queue === 'reported' && item.reports.length
                ? ` — reported: ${item.reports.map((rep) => rep.reason).join(', ')}`
                : '';
              blocks.push({
                type: 'text',
                text: `Photo ${items.length + 1} — image_id ${id} — ${wine ? `"${wineLabel(wine)}"` : 'no wine'}${vintage ? ` ${vintage}` : ''}${reported}`,
              });
              blocks.push({ type: 'image', data: rendered.data, mimeType: rendered.mimeType });
              item.image_included = true;
            }
          }
        } catch (err) {
          console.warn('[mcp] image-queue render failed:', err.message);
        }
      }
      items.push(item);
    }

    const shown = items.filter((i) => i.image_included).map((i) => i.image_id);
    if (shown.length) {
      // Members' unpublished photos are about to leave the platform for the
      // curator's model provider: leave a record, like the label-scan reads.
      logAudit(ctx.req, 'image.moderation_read', { type: 'image', id: null }, { imageIds: shown, queue, via: 'mcp' });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: `${total} photo(s) ${queue === 'reported' ? 'reported' : 'waiting for review'} — showing ${items.length} from ${offset}`,
            data: {
              queue,
              photos: items,
              ...(queue === 'pending' && orphans ? { abandoned_uploads: orphans } : {}),
              ...(truncated ? { note: 'Some photos were left out to keep this response small — call again with a smaller limit or the next offset.' } : {}),
            },
            page: { limit, offset, total },
          }),
        },
        ...blocks,
      ],
    };
  },
});

registerTool({
  name: 'review_image',
  title: 'Sommelier: decide a photo in the review queue',
  description:
    'Decides one photo from list_image_queue. decision: "public" = publish it in the wine\'s gallery, NOT as the ' +
    'wine\'s main picture (e.g. a back label, a second angle); "public_main" = publish it AND make it the wine\'s main ' +
    'picture — refused when the wine already has one unless replace_main is true (look at the current one first with ' +
    'get_photo wine_id); "private" = the uploader keeps it on their own bottle, nobody else sees it (a logo, a shop or ' +
    'app picture with a watermark, anything that is not a photo to publish); "reject" = the photo is taken down and ' +
    'its files deleted, and the uploader is told why — reason is REQUIRED and read verbatim by them; prefer "private" ' +
    'whenever the photo is harmless, because a rejected photo is gone from their bottle too. side records which face ' +
    'the photo shows (front/back). On a REPORTED photo the same decisions answer the report: "public" keeps it ' +
    'published, "private" takes it out of the gallery, "reject" takes it down. Approving tells the uploader it was ' +
    'approved. Not undoable via undo_last — an admin can change it on the web.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    image_id: objectId.describe('From list_image_queue'),
    decision: z.enum(['public', 'public_main', 'private', 'reject']),
    replace_main: z.boolean().default(false)
      .describe('With "public_main": replace the wine\'s current main picture. Only when this photo is clearly better.'),
    side: z.enum(['front', 'back']).optional().describe('Which face of the bottle the photo shows'),
    reason: z.string().max(REJECT_REASON_MAX).optional()
      .describe(`Required with "reject": what the uploader reads, verbatim (max ${REJECT_REASON_MAX} chars)`),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const decision = args.decision;
    if (decision === 'reject' && !(typeof args.reason === 'string' && args.reason.trim())) {
      return fail('invalid_input', 'A reject needs a reason — the uploader reads it. If the photo is harmless, decide "private" instead.');
    }
    if (args.replace_main && decision !== 'public_main') {
      return fail('invalid_input', 'replace_main only goes with decision "public_main".');
    }

    const img = await BottleImage.findById(args.image_id)
      .select('_id kind status visibility reportedAt bottle wineDefinition').lean();
    const state = reviewState(img);
    if (!state) {
      if (!img || img.kind === 'label-scan' || (!img.bottle && !img.wineDefinition)) {
        return fail('not_found', 'No photo with that id is in the review queue. Use list_image_queue for valid ids.');
      }
      return fail('conflict', img.status === 'uploaded' || img.status === 'processing'
        ? 'That photo is still being processed — it joins the queue when background removal is done.'
        : 'That photo has already been decided and has no open report.');
    }

    const base = { imageId: args.image_id, actorId: ctx.user.id, req: ctx.req, via: 'mcp' };
    let result;
    if (decision === 'reject') {
      result = await rejectImage({ ...base, reason: args.reason });
    } else if (state === 'pending') {
      result = await approveImage({
        ...base,
        visibility: decision === 'private' ? 'private' : 'public',
        official: decision === 'public_main',
        replaceMain: args.replace_main === true,
      });
    } else if (decision === 'public_main') {
      result = await setOfficialImage({ ...base, replaceMain: args.replace_main === true, clearReport: true });
    } else if (decision === 'public' && img.visibility === 'public') {
      result = await dismissImageReport(base);
    } else {
      result = await setImageVisibility({ ...base, visibility: decision, clearReport: true });
    }

    if (!result.ok) {
      if (result.code === 'not_found') return fail('not_found', `${result.message}. Use list_image_queue for valid ids.`);
      if (result.code === 'conflict' && result.currentPicture) {
        const wineId = idStr(img.wineDefinition) || idStr((await Bottle.findById(img.bottle).select('wineDefinition').lean())?.wineDefinition);
        return fail('conflict',
          `The wine already has a main picture. Look at it with get_photo${wineId ? ` (wine_id ${wineId})` : ''}; ` +
          'pass replace_main: true only if this photo is clearly the better front picture, or decide "public" to ' +
          'publish it without making it the main picture. Nothing was changed.');
      }
      return fail(result.code === 'conflict' ? 'conflict' : 'invalid_input', result.message);
    }

    if (args.side && decision !== 'reject') {
      await BottleImage.updateOne({ _id: args.image_id }, { $set: { side: args.side } });
    }

    const image = result.image;
    const madeMain = decision === 'public_main';
    const replacedMain = !!result.replacedImage;
    const notified = decision === 'reject' || state === 'pending';
    const SUMMARY = {
      public: state === 'pending' ? 'Photo published in the wine\'s gallery (not its main picture)' : 'Report answered — the photo stays published',
      public_main: `Photo published as the wine's main picture${replacedMain ? ' (replacing the previous one)' : ''}`,
      private: state === 'pending' ? 'Photo approved for the uploader only' : 'Report answered — the photo is out of the gallery, the uploader keeps it',
      reject: 'Photo rejected and deleted',
    };
    const envelope = {
      summary: `${SUMMARY[decision]}${notified ? ' — uploader notified' : ''}`,
      data: {
        image_id: idStr(image._id),
        decision,
        was: state,
        wine_id: idStr(result.wineId || image.wineDefinition?._id || image.wineDefinition),
        main_picture: madeMain,
        replaced_main_picture: replacedMain,
        ...(args.side && decision !== 'reject' ? { side: args.side } : {}),
        uploader_notified: notified,
        note: 'Not undoable via undo_last — an admin can change it on the web (Admin → Images).',
      },
    };
    await logAction(ctx, {
      tool: 'review_image',
      action: 'somm_image_review',
      detail: { imageId: idStr(image._id), decision, was: state, mainPicture: madeMain, replacedMain },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = { uploaderRef, reviewState };
