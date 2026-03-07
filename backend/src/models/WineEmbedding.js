const mongoose = require('mongoose');

/**
 * Tracks which (WineDefinition, vintage) pairs have been embedded and where
 * the vectors live in Qdrant. One document per unique combination of
 * (wineDefinition, vintage, model, indexVersion).
 *
 * The qdrantPointId is the UUID used as the Qdrant point ID.
 * textHash is SHA-256 of the text that was embedded — used to detect when a
 * wine's metadata changed so the vector can be refreshed.
 */
const wineEmbeddingSchema = new mongoose.Schema({
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true,
    index: true
  },
  vintage: {
    type: String,
    required: true,
    trim: true,
    default: 'NV'
  },
  // Which embedding model produced this vector (e.g. 'voyage-4-lite')
  model: {
    type: String,
    required: true,
    trim: true
  },
  // Active index version at embedding time (e.g. 'v1', 'v2')
  indexVersion: {
    type: String,
    required: true,
    trim: true
  },
  // UUID used as the point ID in Qdrant
  qdrantPointId: {
    type: String,
    required: true,
    unique: true
  },
  // SHA-256 of the embedded text — for staleness detection
  textHash: {
    type: String,
    required: true
  },
  embeddedAt: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['ok', 'error'],
    default: 'ok'
  },
  errorMessage: {
    type: String,
    default: null
  }
}, { versionKey: false });

// Primary lookup key
wineEmbeddingSchema.index(
  { wineDefinition: 1, vintage: 1, model: 1, indexVersion: 1 },
  { unique: true }
);

module.exports = mongoose.model('WineEmbedding', wineEmbeddingSchema);
