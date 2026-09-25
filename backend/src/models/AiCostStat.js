const mongoose = require('mongoose');

/**
 * Daily AI spend ledger — one document per (UTC day, feature, model).
 *
 * Until 2026-09-25 only Cellar Chat recorded tokens (ChatUsage), so "where does
 * the Anthropic bill go?" could only be estimated from prompt lengths. Every
 * completed Claude call now adds its `usage` here through the wrapper in
 * services/aiProvider (services/aiCostLedger.recordAiUsage), and SuperAdmin →
 * AI turns the rows into a per-feature cost table.
 *
 * `inputTokens` is the UNCACHED input only — the API reports cache reads and
 * cache writes separately, and each is priced differently (read 0.1×, 5-minute
 * write 1.25×, 1-hour write 2× the input price). `reused` counts answers served
 * from services/aiIdentificationCache instead of a call: free, so no tokens.
 *
 * GDPR: aggregate counters only — no user reference, no prompt or answer text —
 * so there is nothing personal to export or erase, and the model is not in
 * services/userDataRegistry (whose completeness test covers models that
 * reference User). Retention: 400 days, for a year-over-year comparison,
 * enforced by the TTL index on expiresAt.
 */
const aiCostStatSchema = new mongoose.Schema({
  date:               { type: String, required: true }, // 'YYYY-MM-DD' UTC
  feature:            { type: String, required: true }, // 'label_scan', 'import_identify', …
  model:              { type: String, required: true },
  calls:              { type: Number, default: 0 },
  inputTokens:        { type: Number, default: 0 },
  outputTokens:       { type: Number, default: 0 },
  cacheReadTokens:    { type: Number, default: 0 },
  cacheWrite5mTokens: { type: Number, default: 0 },
  cacheWrite1hTokens: { type: Number, default: 0 },
  webSearches:        { type: Number, default: 0 },
  reused:             { type: Number, default: 0 },
  expiresAt:          { type: Date, required: true }, // TTL field — purged automatically
}, { versionKey: false });

aiCostStatSchema.index({ date: 1, feature: 1, model: 1 }, { unique: true });
aiCostStatSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AiCostStat', aiCostStatSchema);
