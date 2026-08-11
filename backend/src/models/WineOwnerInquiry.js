const mongoose = require('mongoose');

/**
 * A curator's question to the OWNERS of a shared registry wine — the one
 * registry-quality channel that reaches the people holding the physical
 * bottle ("what does the label say the producer is?"). Raised by an admin or
 * somm (REST or the MCP tool ask_bottle_owner) against records that web
 * research cannot settle; owners answer in-app from their bottle page, and
 * the answers land in the admin review queue (routes/admin/ownerInquiries.js)
 * and the somm MCP list (list_owner_inquiries, recipients anonymised).
 *
 * GDPR: registered in services/userDataRegistry.js — a recipient's entry
 * (and their answer) is pulled on account erasure, askedBy is nulled on the
 * asker's erasure, and both sides are exported. Retention (also enforced
 * below): an OPEN inquiry expires 60 days after it is asked (lazy sweep →
 * status 'closed'); RESOLVED/CLOSED inquiries are hard-deleted by TTL 180
 * days after resolution — answers are correspondence, not a permanent record.
 */

const RESPONSE_MAX = 1000;

// One entry per notified owner. The bottle is what made them a recipient
// (and where their in-app card renders); the response is single-shot and
// immutable — routes/ownerInquiries.js enforces one answer per recipient.
const recipientSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  bottle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bottle',
  },
  notifiedAt: { type: Date, default: null },
  response: { type: String, trim: true, maxlength: RESPONSE_MAX, default: null },
  respondedAt: { type: Date, default: null },
}, { _id: false });

const wineOwnerInquirySchema = new mongoose.Schema({
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true,
    index: true,
  },
  // Nullable by design: GDPR erasure nulls the asker off their inquiries
  // (the question stays useful to the queue without them).
  askedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  askedVia: {
    type: String,
    enum: ['rest', 'mcp'],
    default: 'rest',
  },
  question: {
    type: String,
    required: [true, 'Question is required'],
    trim: true,
    minlength: [10, 'Question too short'],
    maxlength: [500, 'Question too long'],
  },
  recipients: {
    type: [recipientSchema],
    default: [],
  },
  // open → answered (first owner response) → resolved (admin, with note).
  // 'closed' is lifecycle-only: wine merge/delete or the 60-day expiry sweep.
  status: {
    type: String,
    enum: ['open', 'answered', 'resolved', 'closed'],
    default: 'open',
    index: true,
  },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Set on BOTH resolve and lifecycle close (resolvedBy stays null for the
  // latter) — it is the TTL anchor for the 180-day hard-delete below.
  resolvedAt: { type: Date, default: null },
  // Resolve: what was done with the answers. Close: why it auto-closed.
  resolutionNote: { type: String, trim: true, maxlength: 500 },
  // Answer window: an open inquiry unanswered for 60 days is marked 'closed'
  // by the lazy sweep in services/ownerInquiryOps.js (no cron needed — the
  // sweep runs ahead of every queue read).
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
  },
}, { timestamps: true });

wineOwnerInquirySchema.index({ status: 1, createdAt: -1 });
wineOwnerInquirySchema.index({ 'recipients.user': 1, status: 1 });

// At most ONE open inquiry per wine — two concurrent asks can't both insert
// an open row (same race-safe shape as WineCorrectionProposal's one-pending-
// per-(wine, kind) index; the partial filter means decided rows never collide,
// and 'answered'/'resolved'/'closed' rows leave the constraint).
wineOwnerInquirySchema.index(
  { wineDefinition: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);

// GDPR retention: resolved/closed inquiries hard-delete 180 days after
// resolution. resolvedAt is set on every path out of open/answered (resolve,
// merge/delete closure, expiry sweep), so no decided row escapes the TTL.
wineOwnerInquirySchema.index(
  { resolvedAt: 1 },
  {
    expireAfterSeconds: 180 * 24 * 60 * 60,
    partialFilterExpression: { status: { $in: ['resolved', 'closed'] } },
  }
);

module.exports = mongoose.model('WineOwnerInquiry', wineOwnerInquirySchema);
