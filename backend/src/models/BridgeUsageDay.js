const mongoose = require('mongoose');

/**
 * One row per bridge key per UTC day: how many searches, wine fetches, change
 * checks and contributions the key spent (REGISTRY_LOCKDOWN_PLAN §6 quotas).
 *
 * Quotas exist to make walking the registry slow and visible, not to make
 * adding bottles hard: the defaults are far above what a household spends in
 * a day, and the owner can open a 24-hour import window once a month. Distinct
 * wines per day — the number that actually tells a copier from a household —
 * are counted separately in RegistryReadDay under `key:<id>`, so bridge keys
 * appear in the same daily readers report as everyone else.
 *
 * Retention is short (TTL): the rows are an operational counter. GDPR: they
 * carry the owner's user id, so they are purged with the account and
 * summarised in the export (services/userDataRegistry.js).
 */
const RETENTION_DAYS = 90;

const bridgeUsageDaySchema = new mongoose.Schema({
  key: { type: mongoose.Schema.Types.ObjectId, ref: 'BridgeKey', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  day: { type: String, required: true }, // YYYY-MM-DD, UTC
  searches: { type: Number, default: 0 },
  fetches: { type: Number, default: 0 },
  changeChecks: { type: Number, default: 0 },
  contributions: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

bridgeUsageDaySchema.index({ key: 1, day: 1 }, { unique: true });
bridgeUsageDaySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

bridgeUsageDaySchema.statics.RETENTION_DAYS = RETENTION_DAYS;

module.exports = mongoose.model('BridgeUsageDay', bridgeUsageDaySchema);
