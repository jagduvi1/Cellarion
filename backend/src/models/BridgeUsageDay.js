const mongoose = require('mongoose');

/**
 * One row per ACCOUNT per UTC day: how many searches, wine fetches, change
 * checks and contributions the owner's bridge keys spent between them
 * (REGISTRY_LOCKDOWN_PLAN §6 quotas).
 *
 * Per ACCOUNT, not per key, since the 2026-09-08 audit: the two-key cap counts
 * only active keys, so revoking and re-minting is free, and a per-key row let
 * one account cycle keys to multiply its allowance — each new key arriving
 * with an unused import window — while every individual row stayed under the
 * alert level. `key` records which key opened the day's row; it is attribution,
 * never the identity of the counter.
 *
 * Quotas exist to make walking the registry slow and visible, not to make
 * adding bottles hard: the defaults are far above what a household spends in
 * a day, and the owner can open a 24-hour import window once a month. Distinct
 * wines per day — the number that actually tells a copier from a household —
 * are counted separately in RegistryReadDay under `user:<ownerId>` (detection)
 * and `key:<id>` (attribution), so bridge readers appear in the same daily
 * readers report as everyone else.
 *
 * Retention is short (TTL): the rows are an operational counter. GDPR: they
 * carry the owner's user id, so they are purged with the account and
 * summarised in the export (services/userDataRegistry.js).
 */
const RETENTION_DAYS = 90;

const bridgeUsageDaySchema = new mongoose.Schema({
  // The key that opened this day's row — attribution for the admin page.
  key: { type: mongoose.Schema.Types.ObjectId, ref: 'BridgeKey', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  day: { type: String, required: true }, // YYYY-MM-DD, UTC
  searches: { type: Number, default: 0 },
  fetches: { type: Number, default: 0 },
  changeChecks: { type: Number, default: 0 },
  contributions: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

// The counter's identity. A stale unique {key, day} index from before the
// 2026-09-08 audit is harmless (a key belongs to one account, so its rows stay
// unique), but it can be dropped.
bridgeUsageDaySchema.index({ user: 1, day: 1 }, { unique: true });
bridgeUsageDaySchema.index({ day: 1 });
bridgeUsageDaySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

bridgeUsageDaySchema.statics.RETENTION_DAYS = RETENTION_DAYS;

module.exports = mongoose.model('BridgeUsageDay', bridgeUsageDaySchema);
