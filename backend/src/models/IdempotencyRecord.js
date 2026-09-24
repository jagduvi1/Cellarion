const mongoose = require('mongoose');

/**
 * IdempotencyRecord — the stored outcome of one write sent with an
 * `Idempotency-Key` header (middleware/idempotency.js), so that sending the
 * same write again returns the first outcome instead of applying it twice.
 *
 * Why: offline mode (#1355) queues writes made in a cellar with no signal and
 * sends them when it comes back. In a basement the common failure is not "no
 * network" but "the request arrived and the reply didn't" — without this, the
 * retry would consume a bottle that is already consumed, or clash with its own
 * earlier slot placement.
 *
 * Scoped per user: a key is only ever looked up together with its owner, so one
 * account can never read or collide with another's outcome. `status: null`
 * marks a write still in progress. Rows expire 48 h after creation (TTL) —
 * long enough for a phone to come back online, short enough to be transient.
 *
 * GDPR: registered in services/userDataRegistry.js — purged on account
 * deletion; not exported (a transient technical record of a request already
 * reflected in the exported data itself).
 */
const idempotencyRecordSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key: { type: String, required: true },
  method: { type: String, required: true },
  path: { type: String, required: true },
  status: { type: Number, default: null },
  body: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
});

idempotencyRecordSchema.index({ user: 1, key: 1 }, { unique: true });
// TTL on its own single-field index (a competing plain index on createdAt would
// silently disable TTL — see models/ExportLink.js).
idempotencyRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
