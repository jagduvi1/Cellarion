/**
 * Owner-inquiry operations — ONE implementation shared by the REST create
 * route (routes/admin/ownerInquiries.js) and the MCP tool ask_bottle_owner
 * (mcp/tools/somm.js), plus the lifecycle hooks wine merge/delete call and
 * the lazy expiry sweep every queue read runs (the bottleOps pattern: REST
 * and MCP must not drift on recipient building or conflict semantics).
 *
 * Results are transport-neutral: { ok: true, ... } or { ok: false, code,
 * message } with codes the callers map to HTTP statuses / MCP fail codes.
 */
const mongoose = require('mongoose');
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { CONSUMED_STATUSES } = require('../config/constants');
const { createNotifications } = require('./notifications');
const { logAudit } = require('./audit');
const { stripHtml } = require('../utils/sanitize');
const { isValidId } = require('../utils/validation');

const QUESTION_MIN = 10;
const QUESTION_MAX = 500;
// Fan-out ceiling: enough owners to get an answer, small enough that one ask
// is never a notification blast.
const RECIPIENT_CAP = 20;

const EXPIRY_NOTE = 'Closed automatically: the inquiry expired after 60 days without resolution.';

const wineLabel = (wine) => [wine?.producer, wine?.name].filter(Boolean).join(' — ') || 'this wine';

/**
 * Distinct owners of bottles referencing the wine, newest bottle first, one
 * entry per user, capped at RECIPIENT_CAP. Owners with ACTIVE bottles are the
 * primary audience (they can walk to the shelf and read the label); when the
 * wine has none, owners of consumed bottles are the fallback — they at least
 * held the bottle once. `cellar` rides along only to build the notification
 * deep link; it is not stored on the inquiry.
 */
async function buildRecipients(wineId) {
  const wineOid = new mongoose.Types.ObjectId(String(wineId));
  const ownersWith = (statusMatch) => Bottle.aggregate([
    { $match: { wineDefinition: wineOid, status: statusMatch } },
    { $sort: { createdAt: -1 } },
    // latest makes the cap DETERMINISTIC ($group emits undefined order —
    // audit 2026-08-11 L-3: without the re-sort the 20 kept were arbitrary).
    { $group: { _id: '$user', bottle: { $first: '$_id' }, cellar: { $first: '$cellar' }, latest: { $first: '$createdAt' } } },
    // Demo visitors hold clones of real registry wines but can never answer
    // (respond is requireNonDemo) — without this exclusion they crowd real
    // owners out of the cap (audit 2026-08-11 frontend MEDIUM).
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'owner' } },
    { $match: { 'owner.isDemo': { $ne: true } } },
    { $sort: { latest: -1 } },
    { $limit: RECIPIENT_CAP },
    { $project: { bottle: 1, cellar: 1 } },
  ]);

  let rows = await ownersWith({ $nin: CONSUMED_STATUSES });
  let fallbackUsed = false;
  if (rows.length === 0) {
    rows = await ownersWith({ $in: CONSUMED_STATUSES });
    fallbackUsed = true;
  }
  return {
    recipients: rows
      .filter((r) => r._id) // legacy rows without an owner cannot be asked
      .map((r) => ({ user: r._id, bottle: r.bottle, cellar: r.cellar })),
    fallbackUsed,
  };
}

/**
 * Create an owner inquiry on a wine and notify every recipient. Shared by
 * REST and MCP — identical validation, conflict semantics and audit string
 * on both surfaces (via distinguishes them in the audit detail).
 *
 * @param {object} p
 * @param {string} p.wineId
 * @param {string} p.userId   the asking curator (audit + askedBy)
 * @param {'rest'|'mcp'} p.via
 * @param {*}      p.question raw client value — sanitised here
 * @param {object|null} p.req  for audit attribution only
 * @returns {{ok:true, inquiry, wine, recipientCount:number, fallbackUsed:boolean}
 *         | {ok:false, code:'invalid_input'|'not_found'|'no_owners'|'conflict', message:string}}
 */
async function createOwnerInquiry({ wineId, userId, via = 'rest', question, req = null }) {
  // Plain text only, bounded even after strip — owners read it verbatim in
  // their inquiry card (same hygiene as proposal reasons).
  const clean = stripHtml(typeof question === 'string' ? question : '');
  if (!clean || clean.length < QUESTION_MIN) {
    return { ok: false, code: 'invalid_input', message: `A question of at least ${QUESTION_MIN} characters of plain text is required (HTML is stripped) — the owners read it verbatim.` };
  }
  if (clean.length > QUESTION_MAX) {
    return { ok: false, code: 'invalid_input', message: `The question must be at most ${QUESTION_MAX} characters.` };
  }
  if (!isValidId(String(wineId))) {
    return { ok: false, code: 'invalid_input', message: 'wine id must be a 24-hex id.' };
  }

  const wine = await WineDefinition.findById(wineId).select('name producer pendingIdentity');
  if (!wine) {
    return { ok: false, code: 'not_found', message: 'No registry wine with that id.' };
  }
  // An owner inquiry asks OTHER people's owners what their label says. On a
  // pending-identity row the only owner IS the creator, whose add is what left
  // the identity incomplete — asking them what the curator can already see in
  // the attached scan image is a notification for nothing. Refused loudly so
  // the curator uses the queue's own fix path instead.
  if (wine.pendingIdentity === true) {
    return {
      ok: false,
      code: 'conflict',
      message: 'This wine is in the pending-identity queue — its only bottle owner is the person whose add created it. Read the label scan in that queue and fix it there instead.',
    };
  }

  const { recipients, fallbackUsed } = await buildRecipients(wine._id);
  if (recipients.length === 0) {
    return { ok: false, code: 'no_owners', message: 'No bottle owners found for this wine — nobody has (or had) a bottle of it to ask about.' };
  }

  const now = new Date();
  let inquiry;
  try {
    inquiry = await WineOwnerInquiry.create({
      wineDefinition: wine._id,
      askedBy: userId,
      askedVia: via,
      question: clean,
      recipients: recipients.map((r) => ({ user: r.user, bottle: r.bottle, notifiedAt: now })),
    });
  } catch (err) {
    // The one-open-per-wine partial unique index — a clean conflict, not a
    // stack trace, when a question is already out to the owners.
    if (err?.code === 11000) {
      return { ok: false, code: 'conflict', message: 'An open owner inquiry already exists for this wine — wait for its answers (or resolve it) before asking again.' };
    }
    throw err;
  }

  // In-app + push only (existing notification consent surfaces) — never
  // email. The deep link lands each owner on THEIR bottle, where the inquiry
  // card renders. Batch call: one insertMany + capped push fan-out.
  const label = wineLabel(wine);
  createNotifications(recipients.map((r) => ({
    userId: r.user,
    type: 'owner_inquiry',
    title: 'A curator has a question about your wine',
    message: `Can you help verify the record for ${label}? Open your bottle to read and answer the question.`,
    link: r.cellar && r.bottle ? `/cellars/${r.cellar}/bottles/${r.bottle}` : null,
    category: 'community',
  }))).catch(() => {});

  logAudit(req, 'admin.wine.ownerInquiry.create',
    { type: 'wine', id: wine._id },
    {
      inquiryId: inquiry._id,
      wine: label,
      recipients: recipients.length,
      fallbackUsed,
      ...(via === 'mcp' ? { via: 'mcp' } : {}),
    });

  return { ok: true, inquiry, wine, recipientCount: recipients.length, fallbackUsed };
}

/**
 * Lazy retention sweep (no cron): OPEN inquiries past expiresAt become
 * 'closed' with resolvedAt stamped, which also arms the model's 180-day TTL
 * hard-delete. Runs ahead of every queue read (admin list, /mine, MCP list)
 * so an expired inquiry can never be answered or resolved late.
 */
async function sweepExpiredInquiries() {
  const now = new Date();
  const res = await WineOwnerInquiry.updateMany(
    { status: 'open', expiresAt: { $lt: now } },
    { $set: { status: 'closed', resolvedAt: now, resolutionNote: EXPIRY_NOTE } }
  );
  const closed = res.modifiedCount || 0;
  if (closed > 0) {
    logAudit(null, 'admin.wine.ownerInquiry.close', {}, { reason: 'expired', count: closed });
  }
  return closed;
}

/**
 * One page of the curator review queue, needs-attention-first: answered (has
 * owner answers waiting) > open > resolved/closed, newest first within rank —
 * the status enum sorts uselessly on its own, so the rank is derived. Shared
 * by the admin REST list and the MCP list so the two queues can never
 * disagree on order. Returns lean rows WITHOUT population: each surface
 * projects its own privacy level (admin sees recipient emails, the MCP list
 * anonymises recipients entirely).
 */
async function queryInquiryPage(filter, { limit, offset }) {
  const [rows, total, pendingCount, answeredCount] = await Promise.all([
    WineOwnerInquiry.aggregate([
      { $match: filter },
      { $addFields: { _rank: { $switch: {
        branches: [
          { case: { $eq: ['$status', 'answered'] }, then: 0 },
          { case: { $eq: ['$status', 'open'] }, then: 1 },
        ],
        default: 2,
      } } } },
      { $sort: { _rank: 1, createdAt: -1 } },
      { $skip: offset },
      { $limit: limit },
      { $project: { _rank: 0 } },
    ]),
    WineOwnerInquiry.countDocuments(filter),
    WineOwnerInquiry.countDocuments({ status: { $in: ['open', 'answered'] } }),
    WineOwnerInquiry.countDocuments({ status: 'answered' }),
  ]);
  return { rows, total, pendingCount, answeredCount };
}

/**
 * Wine-merge lifecycle (called by performWineMerge, routes/admin/wines.js):
 * ACTIVE inquiries follow the bottles to the keeper. 'answered' rows always
 * re-point — they carry owner answers that must stay reachable in the queue.
 * The (at most one) 'open' row re-points too, unless the keeper already has
 * its own open inquiry — then it closes with a reason, mirroring the
 * correction-proposal auto-close wording (resolvedBy stays null: lifecycle,
 * not a reviewer's judgement).
 */
async function repointInquiriesForWineMerge(sourceId, targetId, keeperLabel, req = null) {
  const closeNote = `Closed automatically: the wine was merged into "${keeperLabel}". Ask again on that wine if the question still applies.`.slice(0, 500);

  const answered = await WineOwnerInquiry.updateMany(
    { wineDefinition: sourceId, status: 'answered' },
    { $set: { wineDefinition: targetId } }
  );

  const closeOpen = () => WineOwnerInquiry.updateMany(
    { wineDefinition: sourceId, status: 'open' },
    { $set: { status: 'closed', resolvedAt: new Date(), resolutionNote: closeNote } }
  );

  let closedCount = 0;
  let repointedOpen = 0;
  const keeperHasOpen = await WineOwnerInquiry.exists({ wineDefinition: targetId, status: 'open' });
  if (keeperHasOpen) {
    closedCount = (await closeOpen()).modifiedCount || 0;
  } else {
    try {
      repointedOpen = (await WineOwnerInquiry.updateMany(
        { wineDefinition: sourceId, status: 'open' },
        { $set: { wineDefinition: targetId } }
      )).modifiedCount || 0;
    } catch (err) {
      // Raced with a fresh ask on the keeper: the one-open-per-wine index
      // refused the re-point — fall back to the close path.
      if (err?.code !== 11000) throw err;
      closedCount = (await closeOpen()).modifiedCount || 0;
    }
  }

  if (closedCount > 0) {
    logAudit(req, 'admin.wine.ownerInquiry.close',
      { type: 'wine', id: sourceId },
      { reason: 'merge', count: closedCount, targetId });
  }
  return { repointed: repointedOpen + (answered.modifiedCount || 0), closed: closedCount };
}

/**
 * Wine-delete lifecycle (#916 pattern): with the wine gone there is nothing
 * left to verify — close every active inquiry with the reason on the row.
 */
async function closeInquiriesForWineDelete(wineId, req = null) {
  const res = await WineOwnerInquiry.updateMany(
    { wineDefinition: wineId, status: { $in: ['open', 'answered'] } },
    { $set: {
      status: 'closed',
      resolvedAt: new Date(),
      resolutionNote: 'Closed automatically: the wine was deleted before the inquiry was resolved.',
    } }
  );
  const closed = res.modifiedCount || 0;
  if (closed > 0) {
    logAudit(req, 'admin.wine.ownerInquiry.close',
      { type: 'wine', id: wineId },
      { reason: 'wine-deleted', count: closed });
  }
  return closed;
}

module.exports = {
  QUESTION_MIN,
  QUESTION_MAX,
  RECIPIENT_CAP,
  EXPIRY_NOTE,
  buildRecipients,
  createOwnerInquiry,
  sweepExpiredInquiries,
  queryInquiryPage,
  repointInquiriesForWineMerge,
  closeInquiriesForWineDelete,
};
