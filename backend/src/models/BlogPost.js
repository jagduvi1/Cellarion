const mongoose = require('mongoose');

const STATUSES = ['draft', 'published'];

const blogPostSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    minlength: [3, 'Title must be at least 3 characters'],
    maxlength: [200, 'Title too long']
  },
  slug: {
    type: String,
    required: [true, 'Slug is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be URL-friendly (lowercase, hyphens only)']
  },
  excerpt: {
    type: String,
    trim: true,
    maxlength: [500, 'Excerpt too long'],
    default: ''
  },
  content: {
    type: String,
    required: [true, 'Content is required']
  },
  coverImage: {
    type: String,
    trim: true,
    default: ''
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Author is required'],
    index: true
  },
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  status: {
    type: String,
    enum: STATUSES,
    default: 'draft',
    index: true
  },
  publishedAt: {
    type: Date,
    default: null
  },
  metaTitle: {
    type: String,
    trim: true,
    maxlength: [70, 'Meta title should be under 70 characters'],
    default: ''
  },
  metaDescription: {
    type: String,
    trim: true,
    maxlength: [160, 'Meta description should be under 160 characters'],
    default: ''
  }
}, { timestamps: true });

// Public listing: published posts sorted by publish date
blogPostSchema.index({ status: 1, publishedAt: -1 });

module.exports = mongoose.model('BlogPost', blogPostSchema);
module.exports.STATUSES = STATUSES;
