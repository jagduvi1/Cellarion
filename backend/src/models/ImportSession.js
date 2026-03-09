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
  // Full results array from /validate (array of { index, item, status, matches })
  results: { type: mongoose.Schema.Types.Mixed, required: true },
  // User's selections: { [index]: wineId | 'skip' | 'request' }
  selections: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Wines found via manual search modal: { [index]: wineObject }
  manualWines: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ['draft', 'completed'],
    default: 'draft',
    index: true
  }
}, { timestamps: true });

module.exports = mongoose.model('ImportSession', importSessionSchema);
