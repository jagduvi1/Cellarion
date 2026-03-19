const mongoose = require('mongoose');

const discussionReplySchema = new mongoose.Schema({
  discussion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Discussion',
    required: true,
    index: true
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Author is required'],
    index: true
  },
  body: {
    type: String,
    required: [true, 'Body is required'],
    trim: true,
    minlength: [1, 'Reply cannot be empty'],
    maxlength: [3000, 'Reply too long']
  },
  // Snapshot of the quoted reply — stored inline so it survives edits/deletes
  quote: {
    replyId: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscussionReply', default: null },
    authorName: { type: String, default: null },
    body: { type: String, default: null }
  },
  // Optional wine reference — links this reply to a wine from the registry
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    default: null
  },
  likesCount: {
    type: Number,
    default: 0
  },
  // Soft-delete: body is replaced with placeholder; original stored for mod review
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBody: {
    type: String,
    default: null
  }
}, { timestamps: true });

// Thread view: replies in chronological order
discussionReplySchema.index({ discussion: 1, createdAt: 1 });

/**
 * Purge original body text from replies soft-deleted more than 30 days ago.
 * Safe to call on startup and periodically (idempotent).
 */
discussionReplySchema.statics.purgeExpiredDeletes = async function () {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await this.updateMany(
    { isDeleted: true, deletedBody: { $ne: null }, deletedAt: { $lt: cutoff } },
    { $set: { deletedBody: null } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[DiscussionReply] Purged original text from ${result.modifiedCount} expired soft-deleted replies`);
  }
};

module.exports = mongoose.model('DiscussionReply', discussionReplySchema);
