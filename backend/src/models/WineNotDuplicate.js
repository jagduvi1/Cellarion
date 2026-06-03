const mongoose = require('mongoose');

/**
 * An admin-confirmed "these are NOT the same wine" decision for a pair of
 * WineDefinitions. The duplicate-cluster scanner skips any pair recorded here,
 * so wines that legitimately look similar (e.g. single-vineyard bottlings from
 * the same producer) stop resurfacing on every scan.
 *
 * The pair is stored canonically with wineA < wineB (by ObjectId hex string) so
 * it's recorded at most once regardless of argument order; the unique index
 * enforces that. No user reference is stored — the acting admin is captured in
 * the AuditLog instead (GDPR data minimisation).
 */
const wineNotDuplicateSchema = new mongoose.Schema({
  wineA: { type: mongoose.Schema.Types.ObjectId, ref: 'WineDefinition', required: true },
  wineB: { type: mongoose.Schema.Types.ObjectId, ref: 'WineDefinition', required: true },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

wineNotDuplicateSchema.index({ wineA: 1, wineB: 1 }, { unique: true });

module.exports = mongoose.model('WineNotDuplicate', wineNotDuplicateSchema);
