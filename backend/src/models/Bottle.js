const mongoose = require('mongoose');

// One entry per cellar the bottle has lived in, in chronological order. The
// cellar name is snapshotted so the journey survives a later rename/delete of
// that cellar. _id disabled — these are value records, not addressable docs.
const cellarHistorySchema = new mongoose.Schema({
  cellar:     { type: mongoose.Schema.Types.ObjectId, ref: 'Cellar' },
  cellarName: { type: String, trim: true },
  enteredAt:  { type: Date, default: Date.now }
}, { _id: false });

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
    ref: 'WineDefinition'
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
    maxlength: [500, 'Purchase location too long (max 500 characters)']
  },
  purchaseUrl: {
    type: String,
    trim: true,
    maxlength: [2048, 'Purchase URL too long (max 2048 characters)']
  },
  // Cellar management
  location: {
    type: String,
    trim: true,
    maxlength: [500, 'Location too long (max 500 characters)']
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [5000, 'Notes too long (max 5000 characters)']
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
  // Personal per-bottle drink window (calendar years) — the USER'S OWN intent,
  // set by hand or imported (e.g. CellarTracker BeginConsume/EndConsume).
  // Deliberately bottle-level: the shared registry's WineVintageProfile stays
  // sommelier-curated and is never written by imports.
  drinkFrom: {
    type: Number,
    min: [1900, 'Drink-from year must be 1900 or later'],
    max: [2200, 'Drink-from year must be 2200 or earlier'],
    validate: {
      validator: v => v == null || Number.isInteger(v),
      message: 'Drink-from must be a whole year'
    }
  },
  drinkTo: {
    type: Number,
    min: [1900, 'Drink-to year must be 1900 or later'],
    max: [2200, 'Drink-to year must be 2200 or earlier'],
    validate: [
      {
        validator: v => v == null || Number.isInteger(v),
        message: 'Drink-to must be a whole year'
      },
      {
        // Cross-field: runs on save (full-document validation), so it also
        // catches a drinkFrom edit that would invert an existing window.
        validator: function(v) {
          return v == null || this.drinkFrom == null || v >= this.drinkFrom;
        },
        message: 'Drink-to year cannot be before drink-from'
      }
    ]
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
  // When the bottle entered its CURRENT cellar (updated when it's moved between
  // cellars). createdAt stays the original acquisition/added date.
  addedToCellarAt: { type: Date, default: Date.now },
  // Append-only journey across cellars (see cellarHistorySchema). Powers the
  // per-bottle history timeline; each move pushes a new entry.
  cellarHistory: { type: [cellarHistorySchema], default: [] },
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
// Serve the default newest-first list sort from the index. The status filter
// is a $nin (range), so an index ending in createdAt after status cannot serve
// the sort — cellar/user equality + createdAt order with status as a residual
// filter avoids a blocking in-memory SORT over every bottle per page view.
bottleSchema.index({ cellar: 1, createdAt: -1 });
bottleSchema.index({ user: 1, createdAt: -1 });

// Update timestamp on save
bottleSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Bottle', bottleSchema);
