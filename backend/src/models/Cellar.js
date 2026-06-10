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

module.exports = mongoose.model('Cellar', cellarSchema);
