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
 * `confidence` is a TRUST label, not a privacy gate. Community prices are
 * published unattributed (like a shared image), so even an `indicative`
 * (1–2 owner) value is shown — just flagged as low-confidence. Data quality is
 * protected by the cross-vintage cleaner in the job, not by withholding values.
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
  // 'indicative' → 1–2 owners, curve-validated (shown with a low-confidence label)
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
