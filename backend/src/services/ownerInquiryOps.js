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
const NOTE_MIN = 5;
const NOTE_MAX = 500;
// Matches the recipient answer cap — a reply should be able to be as long as
// the answer it responds to.
const OWNER_REPLY_MAX = 1000;
// How long a resolved inquiry keeps rendering its reply on the owner's bottle
// page. Long enough that an owner who answered and went quiet still sees it;
// short enough that the card does not become permanent furniture.
const REPLY_VISIBLE_DAYS = 30;
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
  // Pending-identity wines are deliberately ASKABLE. This used to be refused on
  // the reasoning that the only owner is the creator, so asking them adds
  // nothing over reading the scan — but those two things don't connect. When the
  // scan is unreadable (a washed-out producer line, a label that simply doesn't
  // print the producer, a photo of a screen), the owner is holding the bottle
  // and can read the BACK label, which carries "Mis en bouteille par…". That is
  // strictly more information than the curator has, and it is the only path that
  // resolves the row at all. Refusing it left such wines stuck in the queue
  // forever with no escalation (found in use, 2026-08-12).

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
 * Resolve an inquiry and — this is the point — tell the owners who answered.
 *
 * Shared by the admin REST queue and the somm MCP tool resolve_owner_inquiry,
 * so neither surface can drift on what the owner is told. Two texts, two
 * audiences, never mixed: `note` is the curator's record (admin-only, always
 * required — it is what the queue reads back), `ownerReply` is written TO the
 * owners and reaches them verbatim.
 *
 * Only recipients who actually ANSWERED are notified. A recipient who ignored
 * the question is owed nothing, and "thanks for your answer" to someone who
 * never gave one reads as a bug.
 *
 * @param {object} p
 * @param {string} p.inquiryId
 * @param {string} p.userId       the resolving curator
 * @param {*}      p.note         curator record, 5–500 after strip (required)
 * @param {*}     [p.ownerReply]  user-facing reply; blank sends a plain thank-you
 * @param {'rest'|'mcp'} [p.via]
 * @param {object|null} [p.req]   for audit attribution only
 * @returns {{ok:true, inquiry, notified:number, replySent:string|null}
 *         | {ok:false, code:'invalid_input'|'not_found'|'conflict', message:string}}
 */
async function resolveOwnerInquiry({ inquiryId, userId, note, ownerReply, via = 'rest', req = null }) {
  // Plain text only, bounded even after strip (proposal-reject hygiene).
  const cleanNote = stripHtml(typeof note === 'string' ? note : '');
  if (!cleanNote || cleanNote.length < NOTE_MIN) {
    return { ok: false, code: 'invalid_input', message: `A resolution note of at least ${NOTE_MIN} characters is required — say what was done with the answers.` };
  }
  if (cleanNote.length > NOTE_MAX) {
    return { ok: false, code: 'invalid_input', message: `Resolution note must be at most ${NOTE_MAX} characters.` };
  }
  if (ownerReply != null && typeof ownerReply !== 'string') {
    return { ok: false, code: 'invalid_input', message: 'The owner reply must be text.' };
  }
  const cleanReply = stripHtml(typeof ownerReply === 'string' ? ownerReply : '');
  if (cleanReply.length > OWNER_REPLY_MAX) {
    return { ok: false, code: 'invalid_input', message: `The owner reply must be at most ${OWNER_REPLY_MAX} characters.` };
  }
  if (!isValidId(String(inquiryId))) {
    return { ok: false, code: 'invalid_input', message: 'inquiry id must be a 24-hex id.' };
  }

  // Atomic claim: only an active row can be resolved, so the second of two
  // concurrent resolves loses cleanly (the wineProposals decide pattern) —
  // which is also what stops two curators double-notifying the same owners.
  const oid = new mongoose.Types.ObjectId(String(inquiryId));
  const inquiry = await WineOwnerInquiry.findOneAndUpdate(
    { _id: oid, status: { $in: ['open', 'answered'] } },
    { $set: {
      status: 'resolved',
      resolvedBy: userId,
      resolvedAt: new Date(),
      resolutionNote: cleanNote,
      ownerReply: cleanReply || null,
    } },
    { new: true }
  ).populate('wineDefinition', 'name producer');

  if (!inquiry) {
    const exists = await WineOwnerInquiry.exists({ _id: oid });
    return exists
      ? { ok: false, code: 'conflict', message: 'This inquiry has already been resolved or closed.' }
      : { ok: false, code: 'not_found', message: 'No inquiry with that id.' };
  }

  const answered = (inquiry.recipients || []).filter((r) => r.response);

  logAudit(req, 'admin.wine.ownerInquiry.resolve',
    { type: 'WineOwnerInquiry', id: inquiry._id },
    {
      wineDefinitionId: inquiry.wineDefinition?._id || inquiry.wineDefinition,
      responses: answered.length,
      note: cleanNote,
      // Length only — the reply is correspondence with named users, not audit
      // detail (same line the respond path draws around the answer text).
      ownerReplyLength: cleanReply.length,
      notified: answered.length,
      ...(via === 'mcp' ? { via: 'mcp' } : {}),
    });

  if (answered.length === 0) {
    return { ok: true, inquiry, notified: 0, replySent: cleanReply || null };
  }

  // The deep link needs the CELLAR, which the inquiry deliberately does not
  // store (it is only ever used to build a link) — resolve it from the bottles
  // now. A bottle deleted since the answer simply loses its link.
  const label = wineLabel(inquiry.wineDefinition);
  const bottleIds = answered.map((r) => r.bottle).filter(Boolean);
  const cellarByBottle = new Map();
  if (bottleIds.length > 0) {
    const bottles = await Bottle.find({ _id: { $in: bottleIds } }).select('cellar').lean();
    bottles.forEach((b) => cellarByBottle.set(String(b._id), b.cellar));
  }

  // In-app + push only, exactly like the ask — never email. Best-effort: a
  // notification failure must not un-resolve an inquiry that is already
  // written (the wine-report close draws the same line).
  const fallback = `Thank you — your answer helped settle the record for ${label}.`;
  createNotifications(answered.map((r) => {
    const cellar = cellarByBottle.get(String(r.bottle));
    return {
      userId: r.user,
      type: 'owner_inquiry_resolved',
      title: 'A curator replied about your wine',
      message: cleanReply || fallback,
      link: cellar && r.bottle ? `/cellars/${cellar}/bottles/${r.bottle}` : null,
      category: 'community',
    };
  })).catch(() => {});

  return { ok: true, inquiry, notified: answered.length, replySent: cleanReply || null };
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
  NOTE_MIN,
  NOTE_MAX,
  OWNER_REPLY_MAX,
  REPLY_VISIBLE_DAYS,
  EXPIRY_NOTE,
  buildRecipients,
  createOwnerInquiry,
  resolveOwnerInquiry,
  sweepExpiredInquiries,
  queryInquiryPage,
  repointInquiriesForWineMerge,
  closeInquiriesForWineDelete,
};
