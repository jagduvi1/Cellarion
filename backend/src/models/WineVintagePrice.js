const mongoose = require('mongoose');

/**
 * WineVintagePrice — one document per market-price snapshot for a wine+vintage.
 *
 * Multiple documents accumulate over time to form a price history.
 * The somm queue surfaces wine+vintage pairs whose latest snapshot is absent
 * or older than 3 months.
 */
const wineVintagePriceSchema = new mongoose.Schema({
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

  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative']
  },
  currency: {
    type: String,
    default: 'USD',
    uppercase: true,
    trim: true,
    maxlength: [10, 'Currency code too long']
  },
  // Optional: where the price was sourced (e.g. "Vivino", "Wine-Searcher")
  source: {
    type: String,
    trim: true,
    maxlength: [100, 'Source too long']
  },

  setAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  setBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Optional sommelier notes explaining pricing rationale
  sommNotes: {
    type: String,
    trim: true,
    maxlength: [2000, 'Sommelier notes too long']
  }
});

// Primary access pattern: price history for a wine+vintage in chronological order
wineVintagePriceSchema.index({ wineDefinition: 1, vintage: 1, setAt: -1 });

module.exports = mongoose.model('WineVintagePrice', wineVintagePriceSchema);
