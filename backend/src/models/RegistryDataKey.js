const mongoose = require('mongoose');
const { TYPES } = require('../utils/personalDataTypes');

// The PUBLIC key vocabulary (#985 Slice B) — the shared counterpart of the
// per-user PersonalDataKey. Creating a public key is a CURATED act: users
// propose (name + type + rationale), an ADMIN accepts it into the vocabulary.
// This is what prevents ABV / abv / Alcohol / "Alcohol %" arising as four
// keys — the producer-display-split failure mode, pre-empted in a fresh
// namespace. Supplying a VALUE for an accepted key is the ordinary user act
// (RegistryDataValue), itself human-approved before publishing.

const registryDataKeySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Key name is required'],
    trim: true,
    maxlength: [60, 'Key name too long']
  },
  // Lowercased copy backing the GLOBAL uniqueness index — one vocabulary for
  // everyone, so the namespace guard is global, not per-user.
  nameKey: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    maxlength: 60
  },
  type: {
    type: String,
    enum: TYPES,
    required: [true, 'Key type is required']
  },
  unit: {
    type: String,
    trim: true,
    maxlength: [20, 'Unit too long']
  },
  enumOptions: {
    type: [{ type: String, trim: true, maxlength: [40, 'Enum option too long'] }],
    default: undefined,
    validate: {
      validator: (v) => !v || v.length <= 20,
      message: 'Too many enum options (max 20)'
    }
  },
  // Why this deserves to be a first-class public field — what the admin reads.
  rationale: {
    type: String,
    required: [true, 'Rationale is required'],
    trim: true,
    minlength: [10, 'Rationale too short'],
    maxlength: [1000, 'Rationale too long']
  },
  status: {
    // Indexed via the compound { status, createdAt } queue index below.
    type: String,
    enum: ['proposed', 'accepted', 'rejected'],
    default: 'proposed'
  },
  proposedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decidedAt: { type: Date, default: null },
  rejectReason: { type: String, trim: true, maxlength: 2000 } // 500 was too short for a real explanation (registry backlog 2026-09-06),
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// One live key per name globally: a proposed or accepted key claims the name;
// a rejected one frees it (partial filter), so a better-argued re-proposal
// stays possible without colliding with the tombstone.
registryDataKeySchema.index(
  { nameKey: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['proposed', 'accepted'] } } }
);
// The review queue: status-filtered, oldest-first, bounded.
registryDataKeySchema.index({ status: 1, createdAt: 1 });

registryDataKeySchema.pre('validate', function (next) {
  if (this.name && !this.nameKey) this.nameKey = this.name.toLowerCase();
  next();
});

registryDataKeySchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('RegistryDataKey', registryDataKeySchema);
