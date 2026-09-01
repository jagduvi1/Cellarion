const mongoose = require('mongoose');
const { slugify } = require('../utils/normalize');

const countrySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Country name is required'],
    unique: true,
    trim: true
  },
  code: {
    type: String,
    uppercase: true,
    trim: true,
    maxlength: [2, 'Country code must be 2 characters (ISO 3166-1 alpha-2)'],
    minlength: [2, 'Country code must be 2 characters (ISO 3166-1 alpha-2)']
  },
  normalizedName: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true, index: true },
  // Display names in the reader's language. The canonical `name` above stays
  // English and authoritative — search, dedup, exports and the registry key are
  // all built on it — and these are layered on top for display only, so an
  // untranslated country simply reads as it always has (utils/localizedName).
  // Asked for by a French owner whose own import file wrote "Allemagne" and
  // "Moselle": we already ACCEPT his language on the way in and never give it
  // back (proposal 6a959b9d, 2026-09-01).
  translations: {
    type: Map,
    of: String,
    default: undefined,
  },
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

// (Implicit unique index on `name` from the field declaration covers name lookups.)

countrySchema.pre('save', async function(next) {
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

module.exports = mongoose.model('Country', countrySchema);
