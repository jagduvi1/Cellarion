const mongoose = require('mongoose');

/**
 * CommunityWinePrice — a *derived* community release-price aggregate, one
 * document per (wine, vintage, currency). Recomputed periodically by
 * `communityPriceJob` from what Cellarion users actually paid.
 *
 * This answers "what does this wine cost now (current vintage)?" — the
 * replacement-price signal for ordinary bottles. It is intentionally kept in
 * its own collection, separate from the sommelier-curated, append-only
 * `WineVintagePrice` (which answers the different "what is this old vintage
 * worth on the secondary market?" question).
 *
 * Prices are bucketed *by currency* and never converted across currencies:
 * within one currency every value is same-currency / same-tax and therefore
 * comparable. See docs/wine-valuation-spec.md.
 *
 * Privacy (security audit L-18): a k-anonymity floor of FIRM_MIN_OWNERS (3)
 * distinct owners is enforced both by the aggregation job (sub-floor vintages
 * are never stored, and previously stored ones are cleaned up) and by the
 * read layer (services/communityPrice.js) — a 1–2 owner aggregate would
 * effectively publish an individual user's exact purchase price on a public
 * endpoint. `indicative` therefore no longer reaches clients; the enum is kept
 * for legacy documents until the next job run sweeps them.
 */
const communityWinePriceSchema = new mongoose.Schema({
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true
    // Indexed via the compound indexes below (wineDefinition is their prefix).
  },
  vintage: {
    type: String,
    required: true,
    trim: true
  },
  currency: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    maxlength: [10, 'Currency code too long']
  },

  // Median of distinct owners' representative prices, in `currency`,
  // tax-inclusive exactly as users paid.
  medianPrice: {
    type: Number,
    required: true,
    min: 0
  },
  // Number of DISTINCT owners that contributed (not bottle count).
  sampleSize: {
    type: Number,
    required: true,
    min: 1
  },
  // 'firm'  → sampleSize >= FIRM_MIN_OWNERS (anonymised, high trust)
  // 'indicative' → 1–2 owners; NO LONGER stored or served (k-anonymity floor,
  // L-18) — value kept in the enum only for legacy documents pending cleanup.
  confidence: {
    type: String,
    enum: ['indicative', 'firm'],
    default: 'firm'
  },
  // Optional interquartile range for a "typical range" chip.
  p25: { type: Number },
  p75: { type: Number },

  computedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// One aggregate per wine+vintage+currency.
communityWinePriceSchema.index({ wineDefinition: 1, vintage: 1, currency: 1 }, { unique: true });
// Resolver access pattern: newest vintage first, per wine+currency.
communityWinePriceSchema.index({ wineDefinition: 1, currency: 1, vintage: -1 });

module.exports = mongoose.model('CommunityWinePrice', communityWinePriceSchema);
