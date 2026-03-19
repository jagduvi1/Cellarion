const mongoose = require('mongoose');

const discussionReplyVoteSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  reply: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DiscussionReply',
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Prevent double-likes
discussionReplyVoteSchema.index({ user: 1, reply: 1 }, { unique: true });

module.exports = mongoose.model('DiscussionReplyVote', discussionReplyVoteSchema);
