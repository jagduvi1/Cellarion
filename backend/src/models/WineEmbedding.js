const mongoose = require('mongoose');

/**
 * One wine vector per (WineDefinition, vintage, model, indexVersion): the
 * embedding of the wine's identity and taste profile (services/embedding
 * buildEmbeddingText), searched by services/vectorStore.
 *
 * The vector is stored here, as int8 at the provider's full dimension
 * (services/vectorStore encodeVector): `vector` holds the bytes, `norm` the
 * int8 vector's length (for the cosine) and `dim` its dimension. `vector` is
 * select:false — only the vector store reads it.
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
  // Which embedding model produced this vector (e.g. 'voyage-4-large')
  model: {
    type: String,
    required: true,
    trim: true
  },
  // Index version at embedding time (aiConfig.vectorIndex, e.g. 'v1')
  indexVersion: {
    type: String,
    required: true,
    trim: true
  },
  vector: {
    type: Buffer,
    select: false
  },
  norm: {
    type: Number
  },
  dim: {
    type: Number
  },
  // Legacy: the point id in the retired Qdrant collection. The one-off
  // migration (scripts/migrate-vectors-from-qdrant.js) matches a point to its
  // row by it. Left in place, so a rollback to a Qdrant-based release still
  // finds its points. No longer unique or indexed: new rows have none.
  qdrantPointId: {
    type: String
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
// The registry-wide search: its rows (model + index + dimension) and their
// newest embeddedAt — the in-memory copy's freshness check reads only this.
wineEmbeddingSchema.index({ model: 1, indexVersion: 1, dim: 1, embeddedAt: -1 });

module.exports = mongoose.model('WineEmbedding', wineEmbeddingSchema);
