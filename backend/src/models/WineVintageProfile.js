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
 *   deferred → a somm took the pair out of the queue WITHOUT curating it,
 *              because the wine does not exist in that vintage yet (see the
 *              deferral fields below). Returns to pending on its own.
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
    enum: ['pending', 'reviewed', 'deferred'],
    default: 'pending',
    index: true
  },

  // ── Deferral ────────────────────────────────────────────────────────────────
  // A curator hits a pair that CANNOT be curated: the user typed a vintage the
  // wine has not been released for (most often someone testing the app). Both
  // existing exits are wrong for it — inventing a drink window poisons shared
  // data, and there was no discard at all. Deferring takes the row out of the
  // queue with the values left empty, and brings it back when the vintage
  // plausibly exists.
  //
  // deferredUntil is evaluated at READ time (services/maturityOps.js
  // buildQueueFilter), so a due row rejoins the pending queue by itself — there
  // is no scheduled job here to forget to run or to fail quietly.
  // null = indefinite: the pair only returns if a curator sends it back.
  deferredUntil: { type: Date, default: null, index: true },
  deferredReason: {
    type: String,
    trim: true,
    maxlength: [500, 'Deferral reason too long'],
    default: ''
  },
  deferredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  deferredAt: { type: Date, default: null },

  // When true (used for NV / non-vintage wines), the six phase numbers below are
  // year-OFFSETS after each bottle's purchase year — not absolute calendar years
  // — so the drink window recalculates per bottle (NV has no vintage to anchor
  // to). Offsets are resolved to absolute years client-side only
  // (frontend/src/utils/maturityUtils.js); the backend classifier
  // (backend/src/utils/maturityUtils.js) currently skips NV bottles entirely,
  // so server-side maturity stats/notifications give NV bottles no status.
  relative: { type: Boolean, default: false },

  // Phase 1 — Early drinking (absolute year, or year-offset when `relative`)
  earlyFrom:  { type: Number, min: 0, max: 2200 },
  earlyUntil: { type: Number, min: 0, max: 2200 },

  // Phase 2 — Optimal maturity / peak
  peakFrom:   { type: Number, min: 0, max: 2200 },
  peakUntil:  { type: Number, min: 0, max: 2200 },

  // Phase 3 — Late maturity / tertiary
  lateFrom:   { type: Number, min: 0, max: 2200 },
  lateUntil:  { type: Number, min: 0, max: 2200 },

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
