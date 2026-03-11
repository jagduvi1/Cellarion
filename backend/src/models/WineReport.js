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
    enum: ['wrong_info', 'duplicate', 'inappropriate', 'other'],
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
  status: {
    type: String,
    enum: ['pending', 'resolved', 'dismissed'],
    default: 'pending',
    index: true
  },
  adminNotes: {
    type: String,
    trim: true,
    maxlength: 2000
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
