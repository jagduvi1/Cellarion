const mongoose = require('mongoose');

// Curated reaction set. A small, fixed list (Slack/GitHub-style) keeps the
// signal-to-noise high — free-form emoji pickers create reaction sprawl
// (ten unique reactions on one comment, all single-use). Wine-specific
// kinds (cheers, wine) sit alongside the universal ones.
const REACTION_KINDS = [
  'thumbs_up',  // 👍 agree / good point
  'heart',      // ❤️  love this
  'cheers',     // 🥂 cheers / well-said
  'wine',       // 🍷 want to try
  'thinking',   // 🤔 hmm / interesting
  'target',     // 🎯 spot on
  'laugh',      // 😂 funny
  'pray'        // 🙏 thanks
];

const discussionReactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  reply: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DiscussionReply',
    required: true,
    index: true
  },
  kind: {
    type: String,
    enum: REACTION_KINDS,
    required: true
  }
}, { timestamps: { createdAt: true, updatedAt: false } });

// One user can give multiple kinds to the same reply (Slack/Discord/GitHub
// style — kinds are independent), but only one of each kind per (user, reply).
discussionReactionSchema.index({ user: 1, reply: 1, kind: 1 }, { unique: true });

// For aggregation queries: count by kind for a list of replies.
discussionReactionSchema.index({ reply: 1, kind: 1 });

module.exports = mongoose.model('DiscussionReaction', discussionReactionSchema);
module.exports.REACTION_KINDS = REACTION_KINDS;
