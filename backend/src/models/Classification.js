const mongoose = require('mongoose');
const { normalizeString } = require('../utils/normalize');

/**
 * A classification: a quality tier granted on top of the appellation, as a
 * curated taxonomy row instead of free text (support ticket 2026-10-29,
 * GitHub discussion #1696). Each row says what KIND of tier it is, so a
 * filter can tell a vineyard rank from a ripeness level from an ageing tier:
 *
 *   vineyard_rank  Grand Cru, Premier Cru, Grand Cru Classé, Cru Bourgeois,
 *                  VDP Grosse Lage, Grosses Gewächs …
 *   ripeness       Kabinett, Spätlese, Auslese …, Steinfeder, Federspiel, Smaragd
 *   ageing         Crianza, Reserva, Gran Reserva, Riserva, Gran Selezione,
 *                  the Port and Sherry age statements …
 *   other          designations that are a classification to the label but
 *                  fit none of the above (Single Vineyard, Estate, Reserve)
 *
 * A wine carries an ARRAY of them (WineDefinition.classifications), so
 * "Spätlese" and "VDP Grosse Lage" are two rows, not one string. The legacy
 * free-text WineDefinition.classification is derived from the array by the
 * model (services/classificationOps.classificationString) and kept for every
 * reader that shows or documents it — the public API only gains a field.
 *
 * Mirrors models/Grape: unique normalised name, synonyms with their
 * normalised copies, createdByUser + reviewedAt for the review queue
 * (routes/admin/taxonomy needsHumanReview), and an admin-managed life cycle:
 * rows are added in the taxonomy screen, never by a deploy.
 */

const KINDS = ['vineyard_rank', 'ripeness', 'ageing', 'other'];

const classificationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Classification name is required'],
    unique: true,
    trim: true,
    maxlength: 60
  },
  normalizedName: {
    type: String,
    required: true,
    lowercase: true,
    unique: true,
    index: true
  },
  kind: {
    type: String,
    enum: KINDS,
    required: [true, 'Classification kind is required']
  },
  // The system the tier belongs to, for the admin screen and the API:
  // "Bordeaux 1855", "VDP", "Prädikatswein", "Rioja DOCa", "Vinea Wachau" …
  system: {
    type: String,
    trim: true,
    maxlength: 80,
    default: null
  },
  // Where the tier is law or custom; null for a term used in several countries.
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    default: null
  },
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

classificationSchema.pre('validate', function(next) {
  if (this.name && (this.isModified('name') || !this.normalizedName)) {
    this.normalizedName = normalizeString(this.name);
  }
  next();
});

classificationSchema.pre('save', function(next) {
  if (this.isModified('synonyms') || this.isNew) {
    this.normalizedSynonyms = (this.synonyms || [])
      .map(s => normalizeString(s))
      .filter(Boolean);
  }
  next();
});

const Classification = mongoose.model('Classification', classificationSchema);
Classification.KINDS = KINDS;

module.exports = Classification;
