const mongoose = require('mongoose');

/**
 * Tracks daily AI usage per user against the shared budget (services/aiBudget),
 * one document per (userId, date) pair, mirroring ChatUsage.
 *
 * `count` = AI calls debited that UTC day (chat is counted in ChatUsage):
 * import identify, scan-label (front and back), identify-text, ai-info, receipt
 * scan, user-triggered wine enrichment and the MCP semantic search's embedding.
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
  // Global row only: the highest share of the site-wide cap (50/80/100) the
  // contact address has already been warned about this day, and the cap it
  // was measured against (aiCapAlertJob; a changed cap warns afresh).
  alertedPct: { type: Number },
  alertedCap: { type: Number },
}, { versionKey: false });

aiUsageSchema.index({ userId: 1, date: 1 }, { unique: true });
aiUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
