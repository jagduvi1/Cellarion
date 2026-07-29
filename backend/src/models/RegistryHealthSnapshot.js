const mongoose = require('mongoose');

/**
 * One row per weekly registry-health run (services/registryHealthJob.js) —
 * the baseline the next run compares against, so admins are notified when a
 * metric REGRESSES rather than being re-alerted about a known backlog every
 * week (the alert-once-then-re-baseline pattern the prod registry watchdog
 * proved out).
 *
 * Contains only aggregate counts about shared registry data — no user data,
 * so it has no place in the GDPR export/deletion registry (same category as
 * the metric fields on McpUsageStat). TTL keeps a year of history for
 * trend-reading; the job only ever reads the newest row.
 */
const registryHealthSnapshotSchema = new mongoose.Schema({
  metrics: { type: Map, of: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});

registryHealthSnapshotSchema.index({ createdAt: -1 });
registryHealthSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('RegistryHealthSnapshot', registryHealthSnapshotSchema);
