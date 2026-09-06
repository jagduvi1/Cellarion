const mongoose = require('mongoose');

/**
 * One row per reader per UTC day: which registry wines they read and how
 * many times (registry lockdown 2026-09-06, layer L4).
 *
 * The threat this measures is "copy the registry", and a copy shows up as
 * DISTINCT wines per reader per day — a person browsing reads tens, a scraper
 * reads thousands. Rate limiters count requests in a 15-minute window and
 * cannot tell the two apart; this can. A reader is an anonymous address
 * (`ip:` + the /64-masked rateLimitKey), a signed-in user (`user:` + id) or a
 * token / bridge key. Anonymous readers over the daily distinct cap are
 * refused for the rest of the day (services/registryReadTracker.js); members
 * are never refused, only reported (services/registryReadReportJob.js) —
 * adding bottles must never get harder.
 *
 * Retention is short (RETENTION_DAYS, TTL index): the rows are an operational
 * counter, not history. GDPR: `user:` rows are deleted with the account and
 * summarised in the export (services/userDataRegistry.js).
 */
const RETENTION_DAYS = 14;

const registryReadDaySchema = new mongoose.Schema({
  readerKey: { type: String, required: true },
  day:       { type: String, required: true },   // YYYY-MM-DD, UTC
  kind:      { type: String, required: true, enum: ['ip', 'user', 'token', 'key'] },
  // Distinct wines read. $addToSet keeps it a set; the registry itself bounds
  // its size (a few thousand ObjectIds at the very worst, i.e. a full copy).
  wines:     { type: [mongoose.Schema.Types.ObjectId], default: [] },
  count:     { type: Number, default: 0 },
  // Set once when an anonymous reader crosses the daily cap, so the refusal
  // is audited once rather than on every further request.
  blockedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

registryReadDaySchema.index({ readerKey: 1, day: 1 }, { unique: true });
registryReadDaySchema.index({ day: 1, kind: 1 });
registryReadDaySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

registryReadDaySchema.statics.RETENTION_DAYS = RETENTION_DAYS;

module.exports = mongoose.model('RegistryReadDay', registryReadDaySchema);
