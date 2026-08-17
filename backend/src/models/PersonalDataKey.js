const mongoose = require('mongoose');
const { TYPES } = require('../utils/personalDataTypes');

// A user's private vocabulary of typed keys for personal wine/bottle data
// (issue #986). The type (and unit/options) lives on the KEY, not the value,
// so every value of a key is comparable — which is what lets the future
// analytics catalogue (#987) sort, filter and aggregate personal data.
// Keys are per-user; the shared registry vocabulary (#985) is a separate,
// admin-curated concept.

const personalDataKeySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Key name is required'],
    trim: true,
    maxlength: [60, 'Key name too long']
  },
  // Lowercased copy of name backing the per-user uniqueness index, so "ABV"
  // and "abv" cannot coexist as two keys for the same user.
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
  // Only meaningful for integer/decimal keys ("%", "°C", "kr", …).
  unit: {
    type: String,
    trim: true,
    maxlength: [20, 'Unit too long']
  },
  // Only meaningful for enum keys.
  enumOptions: {
    type: [{ type: String, trim: true, maxlength: [40, 'Enum option too long'] }],
    default: undefined,
    validate: {
      validator: (v) => !v || v.length <= 20,
      message: 'Too many enum options (max 20)'
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

personalDataKeySchema.index({ user: 1, nameKey: 1 }, { unique: true });

personalDataKeySchema.pre('validate', function (next) {
  if (this.name && !this.nameKey) this.nameKey = this.name.toLowerCase();
  next();
});

personalDataKeySchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('PersonalDataKey', personalDataKeySchema);
