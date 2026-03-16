const mongoose = require('mongoose');

const reviewVoteSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  review: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Review',
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Prevent double-likes
reviewVoteSchema.index({ user: 1, review: 1 }, { unique: true });

module.exports = mongoose.model('ReviewVote', reviewVoteSchema);
