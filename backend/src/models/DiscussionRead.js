const mongoose = require('mongoose');

// Records the last time a user opened a given discussion. Used to drive the
// "unread since your last visit" indicator on the discussion list. Inserted
// (or refreshed) lazily when the user fetches a discussion's replies — that's
// the strongest "I'm actually reading this" signal and keeps the upsert off
// the listing-endpoint hot path.
const discussionReadSchema = new mongoose.Schema({
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
  },
  lastReadAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: false });

discussionReadSchema.index({ user: 1, discussion: 1 }, { unique: true });

module.exports = mongoose.model('DiscussionRead', discussionReadSchema);
