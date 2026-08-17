const mongoose = require('mongoose');

// A value for an accepted public key on a registry wine (#985 Slice B).
// Suggested by users, TYPE-validated at entry (utils/personalDataTypes via
// the key's declared type), and human-approved before it publishes — the
// registry stays human-gated; suggestions never auto-apply.
//
// Lifecycle: suggested → published | rejected. One published value per
// (wine, key) is the record; one suggested value per (wine, key) at a time
// keeps the queue free of pile-ups (same one-pending discipline as
// WineCorrectionProposal).

const registryDataValueSchema = new mongoose.Schema({
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true,
    index: true
  },
  key: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RegistryDataKey',
    required: true,
    index: true
  },
  // Already cast/validated against the key's type by the service layer.
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: [true, 'Value is required']
  },
  status: {
    type: String,
    enum: ['suggested', 'published', 'rejected'],
    default: 'suggested',
    index: true
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

// One suggested + one published row per (wine, key); rejected rows keep
// history without blocking a fresh suggestion.
registryDataValueSchema.index(
  { wineDefinition: 1, key: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['suggested', 'published'] } } }
);

registryDataValueSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('RegistryDataValue', registryDataValueSchema);
