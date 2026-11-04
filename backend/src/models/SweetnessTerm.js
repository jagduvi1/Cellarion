const mongoose = require('mongoose');
const { normalizeSweetnessTerm } = require('../utils/normalize');

/**
 * A label sweetness term: the word a label prints for how sweet the wine is
 * (trocken, Brut Nature, amabile, meio seco …), as a curated taxonomy row
 * (GitHub discussion #1754). It is an IDENTITY fact — a Spätlese trocken and
 * a Spätlese are two wines, a house's Brut Nature and its Brut are two wines —
 * and a different thing from the tasting profile's sweetness
 * (WineDefinition.aiProfile.sweetness, a taste estimate), which stays as it is.
 *
 * Each row names its SCALE, because the same word means two things: German
 * "trocken" is the dry band on a still wine and the sec band (17–32 g/l) on a
 * Sekt. The picker offers a wine the terms of its scale (sparkling → the
 * dosage scale, everything else → the still scale; fortified wines have a scale
 * of their own and are out of scope for now). The BAND is the one shared
 * ladder behind every language, so filters and statistics work across them:
 *
 *   still      dry | off-dry | medium-sweet | sweet
 *              (EU: up to 4 g/l — or 9 with enough acidity; up to 12/18; up
 *              to 45; above 45)
 *   sparkling  brut-nature | extra-brut | brut | extra-dry | sec | demi-sec | doux
 *              (under 3 g/l; 0–6; under 12; 12–17; 17–32; 32–50; above 50)
 *
 * `regulated` is false for a customary word without a legal definition
 * (feinherb, "off-dry" on a New World label), so statistics can keep legal
 * bands apart from customary ones. `country` is null for a word the EU defines
 * for a whole language; an admin sets it only on a word that is law in one
 * country.
 *
 * Mirrors models/Classification: unique normalised name (per scale), synonyms
 * with their normalised copies, createdByUser + reviewedAt for the review
 * queue, and an admin-managed life cycle — rows are added in the taxonomy
 * screen (seeded once from data/sweetness-terms.json), never by a deploy.
 */

const SCALES = ['still', 'sparkling'];
const BANDS = {
  still: ['dry', 'off-dry', 'medium-sweet', 'sweet'],
  sparkling: ['brut-nature', 'extra-brut', 'brut', 'extra-dry', 'sec', 'demi-sec', 'doux'],
};
const ALL_BANDS = [...BANDS.still, ...BANDS.sparkling];

const sweetnessTermSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Sweetness term is required'],
    trim: true,
    maxlength: 60
  },
  // The lookup key: lowercased, accents folded, ß → ss (the fold normalizeString
  // alone would delete). Unique together with `scale`, never alone.
  normalizedName: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  scale: {
    type: String,
    enum: SCALES,
    required: [true, 'Scale is required']
  },
  band: {
    type: String,
    enum: ALL_BANDS,
    required: [true, 'Band is required']
  },
  // The definition the row rests on, for the admin screen: "EU 2019/33 Annex
  // III A (de)", "Customary (de)" …
  system: {
    type: String,
    trim: true,
    maxlength: 80,
    default: null
  },
  // Only a word that is law in ONE country carries it; null for a word the EU
  // defines for a whole language (the seed).
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    default: null
  },
  regulated: { type: Boolean, default: true },
  synonyms: {
    type: [String],
    default: []
  },
  normalizedSynonyms: {
    type: [String],
    default: [],
    index: true
  },
  description: { type: String, trim: true, default: '' },
  createdByUser: { type: Boolean, default: false, index: true },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

sweetnessTermSchema.index({ normalizedName: 1, scale: 1 }, { unique: true });

sweetnessTermSchema.pre('validate', function(next) {
  if (this.name && (this.isModified('name') || !this.normalizedName)) {
    this.normalizedName = normalizeSweetnessTerm(this.name);
  }
  // A band belongs to one scale: "sec" is no band of a still wine.
  if (this.scale && this.band && !(BANDS[this.scale] || []).includes(this.band)) {
    this.invalidate('band', `"${this.band}" is not a band of the ${this.scale} scale (${(BANDS[this.scale] || []).join(', ')})`);
  }
  next();
});

sweetnessTermSchema.pre('save', function(next) {
  if (this.isModified('synonyms') || this.isNew) {
    this.normalizedSynonyms = (this.synonyms || [])
      .map((s) => normalizeSweetnessTerm(s))
      .filter(Boolean);
  }
  next();
});

const SweetnessTerm = mongoose.model('SweetnessTerm', sweetnessTermSchema);
SweetnessTerm.SCALES = SCALES;
SweetnessTerm.BANDS = BANDS;
SweetnessTerm.ALL_BANDS = ALL_BANDS;

module.exports = SweetnessTerm;
