const mongoose = require('mongoose');

const CATEGORIES = ['tasting-notes', 'food-pairing', 'recommendations', 'cellar-tips', 'general'];

const discussionSchema = new mongoose.Schema({
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Author is required'],
    index: true
  },
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    minlength: [3, 'Title must be at least 3 characters'],
    maxlength: [200, 'Title too long']
  },
  body: {
    type: String,
    required: [true, 'Body is required'],
    trim: true,
    minlength: [10, 'Body must be at least 10 characters'],
    maxlength: [5000, 'Body too long']
  },
  category: {
    type: String,
    enum: CATEGORIES,
    required: [true, 'Category is required'],
    index: true
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    default: null
  },
  isPinned: {
    type: Boolean,
    default: false
  },
  isLocked: {
    type: Boolean,
    default: false
  },
  replyCount: {
    type: Number,
    default: 0
  },
  lastActivityAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// List views: pinned first, then by last activity
discussionSchema.index({ isPinned: -1, lastActivityAt: -1 });
// Category-filtered views
discussionSchema.index({ category: 1, isPinned: -1, lastActivityAt: -1 });
// User's discussions
discussionSchema.index({ author: 1, createdAt: -1 });

module.exports = mongoose.model('Discussion', discussionSchema);
module.exports.CATEGORIES = CATEGORIES;
