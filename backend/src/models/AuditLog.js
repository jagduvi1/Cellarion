const mongoose = require('mongoose');

const ttlDays = parseInt(process.env.AUDIT_TTL_DAYS || '90', 10); // default 90 days (GDPR)

const auditLogSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now
  },
  actor: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null  // null for anonymous (e.g. failed login with unknown username)
    },
    role: { type: String, default: 'anonymous' },
    ipAddress: { type: String }
  },
  // Dot-separated action name: category.verb[.outcome]
  // e.g. 'auth.login.failed', 'bottle.add', 'cellar.share.add'
  action: {
    type: String,
    required: true,
    index: true
  },
  resource: {
    type:     { type: String },   // 'bottle', 'cellar', 'wine', 'taxonomy', etc.
    id:       { type: mongoose.Schema.Types.ObjectId },
    cellarId: { type: mongoose.Schema.Types.ObjectId, index: true }
  },
  // Action-specific detail payload (free-form)
  detail: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  userAgent: { type: String }
}, { _id: true, versionKey: false });

// Index for per-user queries
auditLogSchema.index({ 'actor.userId': 1, timestamp: -1 });

// The account-erasure scrub finds OTHER users' share events by the departing
// user's email (services/userDataRegistry: detail.sharedWith /
// detail.invitedEmail). Without these it read every audit row on every
// account deletion, which happens hourly with demo-account expiry, so its cost
// grew with users × rows (Mongo profiler 2026-10-14: 92k rows, 143 ms, 45 runs
// in five days). Sparse: only share events carry the fields, so both indexes
// stay tiny, and an equality match on an email can always use them.
auditLogSchema.index({ 'detail.sharedWith': 1 }, { sparse: true });
auditLogSchema.index({ 'detail.invitedEmail': 1 }, { sparse: true });

// TTL: auto-delete old entries if AUDIT_TTL_DAYS is set. The timestamp field
// must not also declare a plain index — two indexes with the same key pattern
// but different options make createIndexes fail with IndexOptionsConflict,
// which would silently prevent the TTL index (and expiry) from being created.
if (ttlDays > 0) {
  auditLogSchema.index(
    { timestamp: 1 },
    { expireAfterSeconds: ttlDays * 86400 }
  );
} else {
  auditLogSchema.index({ timestamp: 1 });
}

// How far back this collection can answer questions about. Exposed as a static
// so callers reading history (the presence ladder on the admin stats page) use
// the SAME window the TTL index enforces, instead of a second hard-coded 90
// that silently disagrees the day AUDIT_TTL_DAYS changes.
auditLogSchema.statics.TTL_DAYS = ttlDays;

module.exports = mongoose.model('AuditLog', auditLogSchema);
