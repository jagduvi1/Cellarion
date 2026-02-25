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

// Compound index: user can't have duplicate cellar names
cellarSchema.index({ user: 1, name: 1 }, { unique: true });
// TTL: auto-purge soft-deleted cellars after 30 days
cellarSchema.index(
  { deletedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { deletedAt: { $ne: null } } }
);
// Index for finding cellars shared with a user
cellarSchema.index({ 'members.user': 1 });

// Update timestamp on save
cellarSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Cellar', cellarSchema);
