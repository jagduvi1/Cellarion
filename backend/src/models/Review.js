const mongoose = require('mongoose');
const { toNormalized } = require('../utils/ratingUtils');

const reviewSchema = new mongoose.Schema({
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Author is required'],
    index: true
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: [true, 'Wine definition is required'],
    index: true
  },
  bottle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bottle',
    default: null
  },
  vintage: {
    type: String,
    trim: true,
    default: null
  },
  rating: {
    type: Number,
    required: [true, 'Rating is required']
  },
  ratingScale: {
    type: String,
    enum: ['5', '20', '100'],
    required: [true, 'Rating scale is required']
  },
  normalizedRating: {
    type: Number,
    required: true
  },
  tasting: {
    aroma: {
      type: String,
      trim: true,
      maxlength: [1000, 'Aroma notes too long']
    },
    palate: {
      type: String,
      trim: true,
      maxlength: [1000, 'Palate notes too long']
    },
    finish: {
      type: String,
      trim: true,
      maxlength: [1000, 'Finish notes too long']
    },
    overall: {
      type: String,
      trim: true,
      maxlength: [2000, 'Overall notes too long']
    }
  },
  likesCount: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// One review per wine per user
reviewSchema.index({ author: 1, wineDefinition: 1 }, { unique: true });
// User's reviews feed
reviewSchema.index({ author: 1, createdAt: -1 });
// Wine's reviews
reviewSchema.index({ wineDefinition: 1, createdAt: -1 });
// Global feed
reviewSchema.index({ createdAt: -1 });

// Compute normalizedRating before validation
reviewSchema.pre('validate', function(next) {
  if (this.isModified('rating') || this.isModified('ratingScale')) {
    this.normalizedRating = toNormalized(this.rating, this.ratingScale);
  }
  next();
});

module.exports = mongoose.model('Review', reviewSchema);
