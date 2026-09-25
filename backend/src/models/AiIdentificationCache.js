const mongoose = require('mongoose');

/**
 * Remembered import identifications — the import lookup's "answer memory"
 * (2026-09-25, services/aiIdentificationCache).
 *
 * One document per distinct identification input: `key` is a SHA-256 of the
 * exact text the prompt receives (wine name, producer, the file's country /
 * appellation / region hints), the model, and a fingerprint of the prompt
 * template — so a changed model or prompt never serves an answer the current
 * configuration would not give. The value is what the model answered: a wine
 * identity, or that it did not recognise the wine.
 *
 * Why: a re-run import, a batch retried after a timeout, or two people
 * importing the same not-yet-registered wine each paid for the same answer.
 *
 * GDPR: no user reference — the stored answer is a wine identity (name,
 * producer, region…), not personal data — so it is not in
 * services/userDataRegistry (whose completeness test covers models that
 * reference User). Retention: 90 days, enforced by the TTL index on expiresAt.
 */
const aiIdentificationCacheSchema = new mongoose.Schema({
  key:         { type: String, required: true, unique: true },
  data:        { type: mongoose.Schema.Types.Mixed, default: null }, // null = the model did not recognise the wine
  debugRaw:    { type: String, default: null },  // the model's raw answer (explains a no-match to the user)
  debugReason: { type: String, default: null },
  expiresAt:   { type: Date, required: true },   // TTL field — purged automatically
}, { versionKey: false });

aiIdentificationCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AiIdentificationCache', aiIdentificationCacheSchema);
