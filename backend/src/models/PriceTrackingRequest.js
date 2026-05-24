const mongoose = require('mongoose');

/**
 * PriceTrackingRequest — opt-in marker for market-price tracking on a
 * specific wine+vintage pair. Users explicitly request that sommeliers
 * research and maintain a price history for the pair.
 *
 * Singleton per (wineDefinition, vintage) — multiple users requesting
 * the same pair share one document and are stored in `requesters`. The
 * somm queue surfaces one card per pair regardless of how many people
 * asked, and all requesters get notified when a price is saved.
 */
const requesterSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  note: {
    type: String,
    trim: true,
    maxlength: [500, 'Note too long']
  }
}, { _id: false });

const priceTrackingRequestSchema = new mongoose.Schema({
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true,
    index: true
  },
  vintage: {
    type: String,
    required: true,
    trim: true
  },
  requesters: {
    type: [requesterSchema],
    default: []
  },
  firstRequestedAt: {
    type: Date,
    default: Date.now
  },
  lastRequestedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

priceTrackingRequestSchema.index({ wineDefinition: 1, vintage: 1 }, { unique: true });

module.exports = mongoose.model('PriceTrackingRequest', priceTrackingRequestSchema);
