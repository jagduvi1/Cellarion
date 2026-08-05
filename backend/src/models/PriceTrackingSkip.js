const mongoose = require('mongoose');

/**
 * PriceTrackingSkip — marks a wine+vintage pair as not worth tracking
 * for price evolution. Wines flagged here are excluded from the somm
 * price queue permanently until the skip is removed.
 *
 * Written by the decline flow (POST /api/somm/prices/requests/:id/decline and
 * the reject_price_request MCP tool): declining a PriceTrackingRequest deletes
 * the request and records a skip, whose `reason` is what the requester was
 * told. routes/bottles.js consults it to refuse re-requests for the pair.
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
