const mongoose = require('mongoose');

const bottleSchema = new mongoose.Schema({
  cellar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cellar',
    required: [true, 'Cellar is required'],
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    index: true
  },
  // User-chosen default image — shown first in the bottle's image carousel
  defaultImage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BottleImage',
    default: null
  },
  // Set when the bottle was imported without a matching wine definition.
  // Cleared (and wineDefinition set) once the admin resolves the request.
  pendingWineRequest: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineRequest',
    index: true
  },
  // Bottle-specific details
  vintage: {
    type: String,
    default: 'NV',
    trim: true,
    maxlength: [20, 'Vintage too long']
  },
  price: {
    type: Number,
    min: [0, 'Price cannot be negative']
  },
  currency: {
    type: String,
    default: 'USD',
    uppercase: true,
    trim: true,
    maxlength: [10, 'Currency code too long']
  },
  // Date ('YYYY-MM-DD') when the price was last entered or confirmed.
  // Used to look up the ExchangeRateSnapshot for time-anchored currency conversion.
  priceSetAt: {
    type: Date
  },
  bottleSize: {
    type: String,
    default: '750ml',
    trim: true,
    maxlength: [20, 'Bottle size too long']
  },
  // Purchase info
  purchaseDate: {
    type: Date
  },
  purchaseLocation: {
    type: String,
    trim: true,
    maxlength: [200, 'Purchase location too long']
  },
  purchaseUrl: {
    type: String,
    trim: true,
    maxlength: [500, 'Purchase URL too long']
  },
  // Cellar management
  location: {
    type: String,
    trim: true,
    maxlength: [200, 'Location too long']
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [2000, 'Notes too long']
  },
  rating: {
    type: Number
  },
  // Scale used when rating was recorded: '5' (stars), '20' (Davis), '100' (Parker)
  ratingScale: {
    type: String,
    enum: ['5', '20', '100'],
    default: '5'
  },
  // Bottle lifecycle — 'active' until the user consumes/gifts/sells it
  status: {
    type: String,
    enum: ['active', 'drank', 'gifted', 'sold', 'other'],
    default: 'active',
    index: true
  },
  consumedAt: { type: Date },
  consumedReason: {
    type: String,
    enum: ['drank', 'gifted', 'sold', 'other']
  },
  consumedNote: {
    type: String,
    trim: true,
    maxlength: [1000, 'Consumed note too long']
  },
  // Rating given at consumption time (separate from the pre-drink rating)
  consumedRating: {
    type: Number
  },
  consumedRatingScale: {
    type: String,
    enum: ['5', '20', '100'],
    default: '5'
  },
  // Drink-window notification tracking — set by the daily notifier job
  drinkWindowNotifiedStatus: { type: String, default: null },
  drinkWindowNotifiedAt:     { type: Date,   default: null },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { optimisticConcurrency: true });

// Compound indexes for efficient queries
bottleSchema.index({ user: 1, cellar: 1, wineDefinition: 1 });
bottleSchema.index({ wineDefinition: 1 }); // For reverse lookup
bottleSchema.index({ cellar: 1, vintage: 1 }); // For filtering by vintage
bottleSchema.index({ cellar: 1, rating: 1 }); // For filtering by rating
bottleSchema.index({ user: 1, vintage: 1 }); // For user-wide vintage queries
bottleSchema.index({ cellar: 1, status: 1 });       // For active/history filtering

// Update timestamp on save
bottleSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Bottle', bottleSchema);
