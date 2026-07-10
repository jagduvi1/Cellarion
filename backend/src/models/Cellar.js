const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  role: {
    type: String,
    enum: ['viewer', 'editor'],
    required: true
  },
  addedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const cellarSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Cellar name is required'],
    trim: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  // Per-user color preferences (owner + members each pick their own)
  userColors: {
    type: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, color: { type: String, required: true } }],
    default: [],
    _id: false
  },
  // Shared access: users who can view or edit this cellar
  members: {
    type: [memberSchema],
    default: []
  },
  // Climate monitoring thresholds (docs/climate-monitoring.md). Absent on
  // cellars that never configured them — readers must fall back to
  // CLIMATE_DEFAULTS (exported below) rather than assuming the path exists.
  climate: {
    type: new mongoose.Schema({
      tempMin: { type: Number, min: -30, max: 60 },
      tempMax: { type: Number, min: -30, max: 60 },
      rhMin: { type: Number, min: 0, max: 100 },
      rhMax: { type: Number, min: 0, max: 100 },
      offlineAfterMin: { type: Number, min: 15, max: 1440 },
      alertsEnabled: { type: Boolean },
    }, { _id: false }),
    default: undefined
  },
  // Soft-delete: set when deleted, null when active
  deletedAt: { type: Date, default: null },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index: user can't have duplicate active cellar names (deleted cellars are excluded)
cellarSchema.index({ user: 1, name: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
// NOTE: no TTL auto-purge of soft-deleted cellars. The previous index used
// partialFilterExpression { deletedAt: { $ne: null } }, which MongoDB rejects
// ($ne is unsupported in partial indexes), so syncIndexes failed every boot
// and the index never existed — the purge has never actually run. Re-adding it
// needs (a) the supported predicate { deletedAt: { $type: 'date' } } AND (b) a
// purge that re-homes/deletes the cellar's Bottles + CellarLayout together,
// because TTL deletion runs no application code and would orphan them
// permanently (CODE_AUDIT_2026-06-10 HIGH: "Cellar TTL purge bypasses cascades").
// Index for finding cellars shared with a user
cellarSchema.index({ 'members.user': 1 });

// Update timestamp on save
cellarSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Shipped alert thresholds: the classic 10–14 °C storage band with headroom
// before alerting, and the 45–80 %RH corridor (dry corks below, mold above).
const CLIMATE_DEFAULTS = Object.freeze({
  tempMin: 8,
  tempMax: 16,
  rhMin: 45,
  rhMax: 80,
  offlineAfterMin: 60,
  alertsEnabled: true,
});

module.exports = mongoose.model('Cellar', cellarSchema);
module.exports.CLIMATE_DEFAULTS = CLIMATE_DEFAULTS;
