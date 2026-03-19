const mongoose = require('mongoose');

const discussionReportSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // Either discussion or reply — one must be set
  discussion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Discussion',
    default: null
  },
  reply: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DiscussionReply',
    default: null
  },
  reason: {
    type: String,
    enum: ['spam', 'harassment', 'off_topic', 'inappropriate', 'other'],
    required: true
  },
  details: {
    type: String,
    trim: true,
    maxlength: 1000
  },
  status: {
    type: String,
    enum: ['pending', 'resolved', 'dismissed'],
    default: 'pending',
    index: true
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  resolvedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

discussionReportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('DiscussionReport', discussionReportSchema);
