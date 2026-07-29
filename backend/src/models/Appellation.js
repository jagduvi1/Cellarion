const mongoose = require('mongoose');
const { normalizeAppellationKey } = require('../utils/normalize');

const appellationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Appellation name is required'],
    trim: true
  },
  normalizedName: {
    type: String,
    required: true,
    lowercase: true
  },
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    required: [true, 'Country is required'],
    index: true
  },
  region: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Region',
    default: null,
    index: true
  },
  // Alternative spellings that resolve to this appellation at write time
  // ("Chateauneuf du Pape" → "Châteauneuf-du-Pape") — same design as
  // Region/Grape synonyms, so a variant can't quietly become a second string
  // on wines. normalizedSynonyms is what lookups match against.
  synonyms: {
    type: [String],
    default: undefined
  },
  normalizedSynonyms: {
    type: [String],
    default: undefined,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// No two appellations with the same name in the same country
appellationSchema.index({ country: 1, normalizedName: 1 }, { unique: true });

// Keep normalizedSynonyms in lockstep with synonyms — same hook as Grape, so
// every save-based admin edit maintains what the write-time lookup matches.
appellationSchema.pre('save', function(next) {
  if (this.isModified('synonyms') || this.isNew) {
    const normalized = (this.synonyms || []).map(s => normalizeAppellationKey(s)).filter(Boolean);
    this.normalizedSynonyms = normalized.length ? normalized : undefined;
  }
  next();
});

module.exports = mongoose.model('Appellation', appellationSchema);
