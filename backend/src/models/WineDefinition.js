const mongoose = require('mongoose');

const wineDefinitionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Wine name is required'],
    trim: true,
    index: true
  },
  producer: {
    type: String,
    required: [true, 'Producer is required'],
    trim: true,
    index: true
  },
  productNumber: {
    type: String,
    trim: true,
    sparse: true,
    index: true
  },
  productNumberShort: {
    type: String,
    trim: true,
    sparse: true,
    index: true
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
  appellation: {
    type: String,
    trim: true
  },
  classification: {
    type: String,
    trim: true,
    default: null
  },
  lwin: {
    lwin7: {
      type: String,
      trim: true,
      sparse: true,
      index: true
    }
  },
  grapes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Grape'
  }],
  type: {
    type: String,
    enum: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
    default: 'red'
  },
  image: {
    type: String,
    default: null
  },
  // Normalized key for deduplication
  normalizedKey: {
    type: String,
    required: true,
    unique: true,
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
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Text index for search
wineDefinitionSchema.index({ name: 'text', producer: 'text' });

// Compound indexes for common filter combinations
wineDefinitionSchema.index({ country: 1, type: 1 });
wineDefinitionSchema.index({ country: 1, region: 1 });
wineDefinitionSchema.index({ type: 1, createdAt: -1 });

// Update timestamp on save
wineDefinitionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('WineDefinition', wineDefinitionSchema);
