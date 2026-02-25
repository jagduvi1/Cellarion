const mongoose = require('mongoose');

const wineRequestSchema = new mongoose.Schema({
  wineName: {
    type: String,
    required: [true, 'Wine name is required'],
    trim: true
  },
  sourceUrl: {
    type: String,
    required: [true, 'Source URL is required'],
    trim: true,
    validate: {
      validator: function(v) {
        return /^https?:\/\/.+/.test(v);
      },
      message: 'Please provide a valid URL'
    }
  },
  image: {
    type: String,
    trim: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'resolved', 'rejected'],
    default: 'pending',
    index: true
  },
  // Admin resolution
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  resolvedAt: {
    type: Date
  },
  linkedWineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition'
  },
  adminNotes: {
    type: String,
    trim: true
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

// Index for admin queue (pending requests, most recent first)
wineRequestSchema.index({ status: 1, createdAt: -1 });

// Update timestamp on save
wineRequestSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('WineRequest', wineRequestSchema);
