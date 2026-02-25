const mongoose = require('mongoose');

/**
 * WineVintageProfile — sommelier-curated maturity data for a specific wine + vintage.
 *
 * Shared across all users who own a bottle of the same wine+vintage combination.
 * Stored separately from Bottle so the data is entered once and reused.
 *
 * Three drinking phases, each expressed as a calendar-year range:
 *   earlyFrom / earlyUntil  — Early drinking window
 *   peakFrom  / peakUntil   — Optimal maturity ⭐
 *   lateFrom  / lateUntil   — Late maturity / tertiary
 *
 * Status lifecycle:
 *   pending  → auto-created when a user adds a bottle with a year vintage
 *   reviewed → set by a somm (or admin) once the window values are filled in
 */
const wineVintageProfileSchema = new mongoose.Schema({
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true,
    index: true
  },
  // Vintage year as a string to match Bottle.vintage (e.g. "2018")
  vintage: {
    type: String,
    required: true,
    trim: true
  },

  status: {
    type: String,
    enum: ['pending', 'reviewed'],
    default: 'pending',
    index: true
  },

  // Phase 1 — Early drinking
  earlyFrom:  { type: Number, min: 1900, max: 2200 },
  earlyUntil: { type: Number, min: 1900, max: 2200 },

  // Phase 2 — Optimal maturity / peak
  peakFrom:   { type: Number, min: 1900, max: 2200 },
  peakUntil:  { type: Number, min: 1900, max: 2200 },

  // Phase 3 — Late maturity / tertiary
  lateFrom:   { type: Number, min: 1900, max: 2200 },
  lateUntil:  { type: Number, min: 1900, max: 2200 },

  // Optional notes from the somm
  sommNotes: {
    type: String,
    trim: true,
    maxlength: [2000, 'Notes too long']
  },

  // Audit fields
  setBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  setAt: {
    type: Date,
    default: null
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// One profile per wine + vintage — prevents duplicates
wineVintageProfileSchema.index({ wineDefinition: 1, vintage: 1 }, { unique: true });

wineVintageProfileSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('WineVintageProfile', wineVintageProfileSchema);
