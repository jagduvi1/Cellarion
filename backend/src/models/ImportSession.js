const mongoose = require('mongoose');

/**
 * Persists a user's import review state so they can resume later.
 * One draft session per user+cellar (upserted on create).
 */
const importSessionSchema = new mongoose.Schema({
  cellar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cellar',
    required: true,
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  fileName: { type: String },
  detectedFormat: { type: String },
  // Non-blocking parse notices (e.g. { code: 'ct-truncated' }) — persisted so a
  // resumed session re-renders the truncation banner instead of dropping it.
  importWarnings: { type: mongoose.Schema.Types.Mixed, default: [] },
  // Cosmetic parse metadata restored on resume: detected file encoding, which
  // CellarTracker table the file was, and Location groups kept as plain text.
  detectedEncoding: { type: String },
  ctTable: { type: String },
  ctTextFallback: { type: mongoose.Schema.Types.Mixed, default: [] },
  // Full results array from /validate (array of { index, item, status, matches })
  results: { type: mongoose.Schema.Types.Mixed, required: true },
  // User's selections: { [index]: wineId | 'skip' | 'request' }
  selections: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Wines found via manual search modal: { [index]: wineObject }
  manualWines: { type: mongoose.Schema.Types.Mixed, default: {} },
  // User's chosen 4-corner anchor for translating source-system positions
  // into Cellarion's top-left/row-major space.
  positionAnchor: { type: String, default: 'top-left' },
  // Per-rack dimension overrides: { [rackName]: { type, rows, cols, typeConfig } }
  rackConfigs: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Currency applied to bottles whose CSV row has no Currency column.
  defaultCurrency: { type: String, default: 'USD', uppercase: true, trim: true },
  // Every session is a draft: finishing an import deletes the session rather
  // than marking it completed, so 'draft' is the only value that ever exists.
  status: {
    type: String,
    enum: ['draft'],
    default: 'draft',
    index: true
  }
}, { timestamps: true });

// Auto-purge abandoned draft sessions after 7 days
importSessionSchema.index({ updatedAt: 1 }, {
  expireAfterSeconds: 7 * 24 * 60 * 60
});

module.exports = mongoose.model('ImportSession', importSessionSchema);
