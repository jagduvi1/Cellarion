const mongoose = require('mongoose');

/**
 * Tracks daily Cellar Chat usage per user.
 * One document per (userId, date) pair. Auto-expires after 90 days (set by
 * the writer in routes/chat.js) — retained that long so the SuperAdmin chat
 * usage panel can show a meaningful history window. GDPR: usage counters +
 * token totals only, no message content; purged with the account.
 */
const chatUsageSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date:         { type: String, required: true }, // 'YYYY-MM-DD' UTC
  count:        { type: Number, default: 0 },
  inputTokens:  { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  expiresAt:    { type: Date, required: true },   // TTL field — purged automatically
}, { versionKey: false });

chatUsageSchema.index({ userId: 1, date: 1 }, { unique: true });
chatUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ChatUsage', chatUsageSchema);
