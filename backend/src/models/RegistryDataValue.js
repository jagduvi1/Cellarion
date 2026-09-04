const mongoose = require('mongoose');

// A value for an accepted public key on a registry wine (#985 Slice B).
// Suggested by users, TYPE-validated at entry (utils/personalDataTypes via
// the key's declared type), and human-approved before it publishes — the
// registry stays human-gated; suggestions never auto-apply.
//
// Lifecycle: suggested → published | rejected. One published value per
// (wine, key, vintage) is the record; one suggested value per slot at a time
// keeps the queue free of pile-ups (same one-pending discipline as
// WineCorrectionProposal).
//
// Vintage slots (2026-09-04): `vintage: null` is the wine-wide DEFAULT,
// 'YYYY' is an OVERRIDE for that bottling only. Readers resolve override →
// default → blank (registryDataOps.resolveForVintage). ABV drifts between
// years, and a retailer page or a label is a fact about ONE year — filing it
// as the wine-wide answer was the mistake the single-slot model forced.

const registryDataValueSchema = new mongoose.Schema({
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true,
    index: true
  },
  key: {
    // No standalone index: every key-filtered query also filters by
    // wineDefinition, served by the compound partial unique index below.
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RegistryDataKey',
    required: true
  },
  // null = applies to every vintage (the default); 'YYYY' = this vintage
  // only. Canonical year string as Bottle.vintage stores it, so a bottle
  // resolves its override by plain equality. Never 'NV'/'Unknown' — those
  // collapse to the default at entry (there is nothing to drift from).
  vintage: {
    type: String,
    default: null
  },
  // Already cast/validated against the key's type by the service layer.
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: [true, 'Value is required']
  },
  status: {
    // Indexed via the compound { status, createdAt } queue index below.
    type: String,
    enum: ['suggested', 'published', 'rejected'],
    default: 'suggested'
  },
  // Provenance — who contributed, who verified. Survives account deletion as
  // the anonymised deleted-user sentinel (shared content, like forum posts).
  suggestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  evidenceUrl: {
    type: String,
    trim: true,
    maxlength: 500,
    validate: {
      validator: (v) => !v || /^https?:\/\//i.test(v),
      message: 'evidenceUrl must start with http:// or https://',
    },
  },
  reason: { type: String, trim: true, maxlength: 1000 },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decidedAt: { type: Date, default: null },
  rejectReason: { type: String, trim: true, maxlength: 500 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// One suggested + one published row per (wine, key, vintage slot); rejected
// rows keep history without blocking a fresh suggestion. Rows written before
// the vintage field existed have no `vintage` at all — Mongo indexes a
// missing field as null, so they occupy the default slot exactly as intended.
// Replaces the pre-vintage { wineDefinition, key, status } unique index:
// config/db.js syncIndexes() drops that one on existing databases.
registryDataValueSchema.index(
  { wineDefinition: 1, key: 1, vintage: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['suggested', 'published'] } } }
);
// The review queue: status-filtered, oldest-first, bounded.
registryDataValueSchema.index({ status: 1, createdAt: 1 });

registryDataValueSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('RegistryDataValue', registryDataValueSchema);
