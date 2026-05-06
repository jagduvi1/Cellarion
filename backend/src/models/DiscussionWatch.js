const mongoose = require('mongoose');

// One row per (user, discussion) pair when the user is following a thread.
// Created automatically when a user posts/replies to a thread, or manually
// via the Follow button. Reply fan-out queries this collection to notify
// every watcher in addition to the OP / quoted-author / mentions.
const discussionWatchSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  discussion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Discussion',
    required: true,
    index: true
  }
}, { timestamps: { createdAt: true, updatedAt: false } });

discussionWatchSchema.index({ user: 1, discussion: 1 }, { unique: true });

module.exports = mongoose.model('DiscussionWatch', discussionWatchSchema);
