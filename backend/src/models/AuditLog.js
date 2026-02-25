const mongoose = require('mongoose');

const ttlDays = parseInt(process.env.AUDIT_TTL_DAYS || '0', 10); // 0 = keep forever

const auditLogSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
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

// TTL: auto-delete old entries if AUDIT_TTL_DAYS is set
if (ttlDays > 0) {
  auditLogSchema.index(
    { timestamp: 1 },
    { expireAfterSeconds: ttlDays * 86400 }
  );
}

module.exports = mongoose.model('AuditLog', auditLogSchema);
