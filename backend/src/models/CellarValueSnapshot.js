const mongoose = require('mongoose');

const cellarValueSnapshotSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  cellar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cellar',
    required: true
  },
  date: {
    type: String, // 'YYYY-MM-DD'
    required: true
  },
  totalValue: {
    type: Number, // cost basis (what the user paid), in USD as canonical currency
    required: true
  },
  // Estimated replacement value (what it'd cost to rebuy), in USD. Resolved per
  // bottle as secondary ?? currentRelease ?? paid (see services/valuation.js).
  // Optional for back-compat with snapshots created before Phase 1.
  replacementValue: {
    type: Number
  },
  bottleCount: {
    type: Number,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Efficient time-series queries per user
cellarValueSnapshotSchema.index({ user: 1, date: -1 });
// Prevent duplicate snapshots per cellar per day
cellarValueSnapshotSchema.index({ cellar: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('CellarValueSnapshot', cellarValueSnapshotSchema);
