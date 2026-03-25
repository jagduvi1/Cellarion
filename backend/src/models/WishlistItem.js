const mongoose = require('mongoose');

const wishlistItemSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: [true, 'Wine definition is required'],
    index: true
  },
  vintage: {
    type: String,
    trim: true,
    maxlength: [20, 'Vintage too long']
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [2000, 'Notes too long']
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['wanted', 'bought'],
    default: 'wanted',
    index: true
  },
  boughtAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes
wishlistItemSchema.index({ user: 1, status: 1, createdAt: -1 });
wishlistItemSchema.index({ user: 1, wineDefinition: 1 });

// Update timestamp on save
wishlistItemSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('WishlistItem', wishlistItemSchema);
