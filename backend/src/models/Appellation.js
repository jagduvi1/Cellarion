const mongoose = require('mongoose');

const appellationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Appellation name is required'],
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
  region: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Region',
    default: null,
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

// No two appellations with the same name in the same country
appellationSchema.index({ country: 1, normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('Appellation', appellationSchema);
