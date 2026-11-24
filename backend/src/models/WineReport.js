const mongoose = require('mongoose');

const wineReportSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true,
    index: true
  },
  reason: {
    type: String,
    enum: ['wrong_info', 'duplicate', 'inappropriate', 'wrong_price', 'wrong_tasting_profile', 'other'],
    required: true,
    index: true
  },
  details: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  // For duplicate reports — the wine they think this is a duplicate of
  duplicateOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition'
  },
  // Optional STRUCTURED correction: "this field should say this" instead of
  // prose the admin has to re-type elsewhere.
  // Only the one-click-appliable string fields — region/country are refs and
  // stay free-text in `details`. Resolution can apply this in one action.
  suggestedField: {
    type: String,
    enum: ['name', 'producer', 'appellation', 'type'],
    default: undefined
  },
  suggestedValue: {
    type: String,
    trim: true,
    maxlength: 200
  },
  status: {
    type: String,
    enum: ['pending', 'resolved', 'dismissed'],
    default: 'pending',
    index: true
  },
  // The reply the reporter reads on their Support page, and named for what it
  // is: there is no internal-notes counterpart, so anything written here is
  // user-facing.
  adminResponse: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  respondedAt: {
    type: Date
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  resolvedAt: {
    type: Date
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

wineReportSchema.index({ status: 1, createdAt: -1 });

wineReportSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('WineReport', wineReportSchema);
