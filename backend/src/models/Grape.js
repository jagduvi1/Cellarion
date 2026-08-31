const mongoose = require('mongoose');
const { slugify, normalizeString } = require('../utils/normalize');

// One regionally correct display name for one place — see `regionalNames`
// below. No per-entry _id: entries are replaced wholesale by the admin editor
// and referenced by (country, region) pair, never individually.
const regionalNameSchema = new mongoose.Schema({
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    required: [true, 'A regional name needs a country']
  },
  region: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Region',
    default: null
  },
  name: {
    type: String,
    required: [true, 'A regional name needs a name'],
    trim: true,
    maxlength: 60
  }
}, { _id: false });

const grapeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Grape name is required'],
    unique: true,
    trim: true
  },
  normalizedName: {
    type: String,
    required: true,
    lowercase: true,
    unique: true,
    index: true
  },
  color: {
    type: String,
    enum: ['Red', 'White'],
    default: null
  },
  origin: {
    type: String,
    trim: true,
    default: null
  },
  characteristics: {
    type: [String],
    default: []
  },
  agingPotential: {
    type: String,
    trim: true,
    default: null
  },
  prestige: {
    type: String,
    trim: true,
    default: null
  },
  synonyms: {
    type: [String],
    default: []
  },
  // Lowercase/diacritic-free forms of `synonyms`, maintained by the pre-save
  // hook below. Lets findOrCreateGrapes resolve a local name ("Tinta Roriz")
  // to its canonical Grape document instead of creating a duplicate — the
  // display name stays local on the grape page ("also known as …") while
  // filters, stats and similarity see one variety.
  normalizedSynonyms: {
    type: [String],
    default: [],
    index: true
  },
  // Regionally correct display names for this variety: a Douro wine shows
  // "Tinta Roriz", an Alentejo one "Aragonez" — both stored as this ONE
  // canonical doc, so search facets, stats and pairing keep a single
  // vocabulary. `region` unset means the name applies country-wide; an entry
  // with a region wins over a country-only entry (utils/grapeDisplay.js).
  // Deliberately NO normalized copies of these names: they are display-only
  // and never matched against user input — resolving a typed "Tinta Roriz" to
  // this doc stays the job of synonyms/normalizedSynonyms above.
  regionalNames: {
    type: [regionalNameSchema],
    default: []
  },
  slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true, index: true },
  // WHERE THIS DOCUMENT CAME FROM — a permanent fact, never cleared.
  //
  // True when a user write minted this grape (bottle-add / import via
  // findOrCreateGrapes) rather than a curator. Unreviewed user mints polluted
  // the shared taxonomy silently ("Honey" via a mead, "Alvarão" for
  // Alvarinho — somm ticket 6a942a60, 2026-08-30).
  //
  // Renamed from `pendingReview` on 2026-08-31 for the reason spelled out on
  // models/Region: the old name promised an action for a field that only
  // recorded an origin. Same two-fact split as Region, and the same split the
  // wine registry already used — createdVia says where a record came from,
  // profileReviewedAt says whether a human has judged it.
  createdByUser: { type: Boolean, default: false, index: true },
  // When an admin actually reviewed this grape, and who. Null means nobody
  // has, which is not by itself a problem — see needsHumanReview.
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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

// Keep normalizedSynonyms in lockstep with synonyms (admin edits go through
// .save(), so this covers the taxonomy route).
grapeSchema.pre('save', function(next) {
  if (this.isModified('synonyms') || this.isNew) {
    this.normalizedSynonyms = (this.synonyms || [])
      .map(s => normalizeString(s))
      .filter(Boolean);
  }
  next();
});

grapeSchema.pre('save', async function(next) {
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

module.exports = mongoose.model('Grape', grapeSchema);
