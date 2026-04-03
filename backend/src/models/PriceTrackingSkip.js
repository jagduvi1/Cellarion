const mongoose = require('mongoose');

/**
 * PriceTrackingSkip — marks a wine+vintage pair as not worth tracking
 * for price evolution. Wines flagged here are excluded from the somm
 * price queue permanently until the skip is removed.
 */
const priceTrackingSkipSchema = new mongoose.Schema({
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true
  },
  vintage: {
    type: String,
    required: true,
    trim: true
  },
  reason: {
    type: String,
    trim: true,
    maxlength: [500, 'Reason too long']
  },
  skippedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  skippedAt: {
    type: Date,
    default: Date.now
  }
});

priceTrackingSkipSchema.index({ wineDefinition: 1, vintage: 1 }, { unique: true });

module.exports = mongoose.model('PriceTrackingSkip', priceTrackingSkipSchema);
