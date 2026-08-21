const mongoose = require('mongoose');
const { slugify } = require('../utils/normalize');

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
    minlength: [1, 'Body is required'],
    // Raw HTML cap. UX-level visible-text length is validated in the route
    // (against DISCUSSION_MAX_LENGTHS.body); this is the schema-level hard
    // ceiling that prevents an attacker from posting megabytes of HTML.
    maxlength: [8000, 'Body too long']
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
  // The blog post this thread discusses, when it was opened from one.
  //
  // Origin (2026-08-21): a user asked for blog post SEARCH; comments were a
  // separate idea raised alongside it, and this is the form they took.
  //
  // A ref rather than a comment system, deliberately. Blog comments would have
  // been a second community surface, and the first one is quiet — 5 threads and
  // 12 replies from users who are already logged in and invested. Blog readers
  // arrive from search and mostly aren't signed in, so an authenticated comment
  // box would be quieter still, while an anonymous one on a crawlable page is a
  // spam target with a single moderator.
  //
  // Pointing at Discussion inherits the parts that are expensive to get right
  // and already correct here: the report queue and moderator role, the
  // GDPR export and deletion cascade registered in services/userDataRegistry,
  // and Meili indexing. A bespoke BlogComment model would have had to re-earn
  // all four.
  blogPost: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BlogPost',
    default: null,
    index: true
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
  },
  // Human-readable URL slug. Pinned at create time and never regenerated on
  // title edit — URLs stay stable forever, old links don't break. Sparse so
  // existing pre-migration discussions don't violate the unique index until
  // backfilled.
  slug: {
    type: String,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
    index: true
  }
}, { timestamps: true });

// List views: pinned first, then by last activity
discussionSchema.index({ isPinned: -1, lastActivityAt: -1 });
// Category-filtered views
discussionSchema.index({ category: 1, isPinned: -1, lastActivityAt: -1 });
// User's discussions
discussionSchema.index({ author: 1, createdAt: -1 });
// "Newest" tab sort
discussionSchema.index({ isPinned: -1, createdAt: -1 });
// "Most replies" tab sort
discussionSchema.index({ isPinned: -1, replyCount: -1, lastActivityAt: -1 });
// Wine-page discussions panel (public, crawler-visited)
discussionSchema.index({ wineDefinition: 1, isPinned: -1, lastActivityAt: -1 });

// Generate slug from title + last 6 of ObjectId on insert. The ObjectId suffix
// gives collision-resistance without needing a uniqueness retry loop.
discussionSchema.pre('save', function(next) {
  if (this.slug || !this.isNew) return next();
  const base = slugify(this.title);
  const suffix = this._id.toString().slice(-6);
  this.slug = base ? `${base}-${suffix}` : suffix;
  next();
});

module.exports = mongoose.model('Discussion', discussionSchema);
module.exports.CATEGORIES = CATEGORIES;
