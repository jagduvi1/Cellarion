const mongoose = require('mongoose');

const regionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Region name is required'],
    trim: true
  },
  normalizedName: {
    type: String,
    required: true,
    lowercase: true
  },
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    required: [true, 'Country is required'],
    index: true
  },
  parentRegion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Region',
    default: null
  },
  hierarchy: {
    type: [String],
    default: []
  },
  classification: {
    type: String,
    trim: true,
    default: null
  },
  styles: {
    type: [String],
    default: []
  },
  agingRules: {
    legalMinMonths: { type: Number, default: null },
    notes: { type: String, default: null }
  },
  prestigeLevel: {
    type: String,
    trim: true,
    default: null
  },
  typicalGrapes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Grape'
  }],
  permittedGrapes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Grape'
  }],
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

// Compound index to prevent duplicate regions in same country
regionSchema.index({ country: 1, normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('Region', regionSchema);
