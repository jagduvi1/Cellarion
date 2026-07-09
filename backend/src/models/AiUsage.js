const mongoose = require('mongoose');

/**
 * Tracks daily Anthropic-backed AI usage per user (SECURITY_AUDIT_2026-07-08
 * M-2 / L-14). One document per (userId, date) pair, mirroring ChatUsage.
 *
 * `count` is the number of actual Anthropic calls debited that UTC day across
 * import identify, scan-label, identify-text, ai-info, and user-triggered
 * wine enrichment. Chat keeps its own separate quota (ChatUsage).
 *
 * The site-wide daily kill-switch (rateLimits.aiGlobalDailyCap) is tracked as
 * a singleton row per day with `userId: null` — not personal data.
 *
 * Auto-expires after 90 days (set by services/aiBudget.js) — same retention
 * window as ChatUsage. GDPR: usage counters only, no content; purged with the
 * account via services/userDataRegistry.js.
 */
const aiUsageSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // null = global site-wide counter
  date:      { type: String, required: true }, // 'YYYY-MM-DD' UTC
  count:     { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },   // TTL field — purged automatically
}, { versionKey: false });

aiUsageSchema.index({ userId: 1, date: 1 }, { unique: true });
aiUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
