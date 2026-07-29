const mongoose = require('mongoose');
const { slugify, normalizeString } = require('../utils/normalize');

const regionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Region name is required'],
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
  parentRegion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Region',
    default: null
  },
  hierarchy: {
    type: [String],
    default: []
  },
  classification: {
    type: String,
    trim: true,
    default: null
  },
  styles: {
    type: [String],
    default: []
  },
  agingRules: {
    legalMinMonths: { type: Number, default: null },
    notes: { type: String, default: null }
  },
  prestigeLevel: {
    type: String,
    trim: true,
    default: null
  },
  typicalGrapes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Grape'
  }],
  permittedGrapes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Grape'
  }],
  // Alternate names for the same region ("Piemonte" for Piedmont, "Douro
  // Valley" for Douro). Mirrors the Grape synonym design: findOrCreateRegion
  // matches these so a merged duplicate can't be re-minted by label scan.
  synonyms: {
    type: [String],
    default: []
  },
  normalizedSynonyms: {
    type: [String],
    default: [],
    index: true
  },
  // True while this region was auto-minted by a user write (label scan,
  // add-bottle, import) and no admin has looked at it yet (strategy 2026-07-29
  // R3). Self-minting is why the collection needed cleanup scripts twice in
  // July: any comma-free non-country string becomes taxonomy silently. The
  // flag makes the mint VISIBLE instead of blocking it — a user adding a
  // bottle is never held up by taxonomy review. Admin-created regions are
  // born reviewed (flag absent).
  pendingReview: { type: Boolean, default: false, index: true },
  // Public-facing URL slug and curator description for /regions/:slug pages.
  slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true, index: true },
  description: { type: String, trim: true, default: '' },
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

// Compound index to prevent duplicate regions in same country
regionSchema.index({ country: 1, normalizedName: 1 }, { unique: true });

// Keep normalizedSynonyms in lockstep with synonyms (admin edits and the
// taxonomy merge service both go through .save()).
regionSchema.pre('save', function(next) {
  if (this.isModified('synonyms') || this.isNew) {
    this.normalizedSynonyms = (this.synonyms || [])
      .map(s => normalizeString(s))
      .filter(Boolean);
  }
  next();
});

// Auto-generate slug for new regions. Never overwrite an existing slug.
regionSchema.pre('save', async function(next) {
  if (this.slug || !this.isNew) return next();
  const base = slugify(this.name);
  if (!base) return next();
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const hit = await this.constructor.findOne({ slug: candidate }).select('_id').lean();
    if (!hit) break;
    candidate = `${base}-${i}`;
  }
  this.slug = candidate;
  next();
});

module.exports = mongoose.model('Region', regionSchema);
