const mongoose = require('mongoose');

const pendingShareSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  cellar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cellar',
    required: true
  },
  role: {
    type: String,
    enum: ['viewer', 'editor'],
    required: true
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: { type: Date, default: Date.now }
});

// Prevent duplicate invites for same email + cellar
pendingShareSchema.index({ email: 1, cellar: 1 }, { unique: true });

// Auto-expire after 90 days
pendingShareSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('PendingShare', pendingShareSchema);
