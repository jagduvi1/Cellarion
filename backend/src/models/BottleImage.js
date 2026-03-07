const mongoose = require('mongoose');

const bottleImageSchema = new mongoose.Schema({
  bottle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bottle',
    default: null,
    index: true
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    default: null,
    index: true
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  originalUrl: {
    type: String,
    required: true
  },
  processedUrl: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['uploaded', 'processing', 'processed', 'approved', 'rejected'],
    default: 'uploaded',
    index: true
  },
  credit: {
    type: String,
    default: null,
    trim: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  assignedToWine: {
    type: Boolean,
    default: false
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

bottleImageSchema.index({ status: 1, createdAt: -1 });
bottleImageSchema.index({ bottle: 1, status: 1 });
bottleImageSchema.index({ wineDefinition: 1, assignedToWine: 1 });

bottleImageSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('BottleImage', bottleImageSchema);
