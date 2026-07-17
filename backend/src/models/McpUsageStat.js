const mongoose = require('mongoose');

/**
 * Aggregate per-day MCP usage counters — the data behind the admin usage view
 * (GET /api/admin/mcp/usage). One row per UTC day × surface × kind × name,
 * $inc-upserted from the budgeted handler wrappers in mcp/server.js.
 *
 * DELIBERATELY AGGREGATE-ONLY: no user reference, no arguments, no results —
 * an admin needs "is MCP used, which tools, how much, error rate", not who
 * asked what (data minimisation; the per-user story lives in McpActionLog,
 * which the user themselves can see and export). Because there is no user
 * link, the model sits in userDataRegistry's EXCLUDED list.
 */
const mcpUsageStatSchema = new mongoose.Schema({
  // UTC midnight of the day being counted.
  day: { type: Date, required: true },
  surface: { type: String, enum: ['personal', 'public'], required: true },
  kind: { type: String, enum: ['tool', 'resource', 'prompt'], required: true },
  // Tool/resource/prompt name as registered in mcp/registry.js.
  name: { type: String, required: true, maxlength: 100 },
  calls: { type: Number, default: 0 },
  // Calls whose result envelope carried isError (or whose handler threw).
  // Named errorCount, not errors — `errors` is a reserved Mongoose pathname.
  errorCount: { type: Number, default: 0 },
}, { versionKey: false });

mcpUsageStatSchema.index({ day: 1, surface: 1, kind: 1, name: 1 }, { unique: true });
// Bound growth: drop counters after 180 days (admin view reads ≤90). Single-
// purpose TTL index — key pattern differs from the compound above, so no
// IndexOptionsConflict (see models/AuditLog.js for the failure mode).
mcpUsageStatSchema.index({ day: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const McpUsageStat = mongoose.model('McpUsageStat', mcpUsageStatSchema);

/**
 * Fire-and-forget counter bump. Never awaited by callers and never throws —
 * a stats hiccup must not fail a tool call. No-ops without a live connection
 * so the directly-unit-tested budgeted handlers (no DB in jest) stay pure.
 */
McpUsageStat.record = function record({ surface, kind, name, error }) {
  if (mongoose.connection.readyState !== 1) return;
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  McpUsageStat.updateOne(
    { day, surface, kind, name: String(name).slice(0, 100) },
    { $inc: { calls: 1, errorCount: error ? 1 : 0 } },
    { upsert: true }
  ).catch(() => {});
};

module.exports = McpUsageStat;
