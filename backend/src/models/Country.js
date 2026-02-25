const mongoose = require('mongoose');

const countrySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Country name is required'],
    unique: true,
    trim: true
  },
  code: {
    type: String,
    uppercase: true,
    trim: true,
    maxlength: [2, 'Country code must be 2 characters (ISO 3166-1 alpha-2)'],
    minlength: [2, 'Country code must be 2 characters (ISO 3166-1 alpha-2)']
  },
  normalizedName: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for name lookups
countrySchema.index({ name: 1 });

module.exports = mongoose.model('Country', countrySchema);
