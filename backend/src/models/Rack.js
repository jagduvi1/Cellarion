const mongoose = require('mongoose');

const RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf'];

const slotSchema = new mongoose.Schema({
  position: { type: Number, required: true },
  bottle:   { type: mongoose.Schema.Types.ObjectId, ref: 'Bottle', required: true },
  rfidTag:  { type: String }
}, { _id: false });

// Named area of a rack ("Whites", "Bordeaux", …) — a set of global slot
// positions with a display color. A position belongs to at most one zone
// (enforced in the route, not the schema).
const zoneSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true, maxlength: 40 },
  color:     { type: String, trim: true, maxlength: 20 },
  positions: { type: [Number], default: [] },
}, { _id: false });

const rackModuleSchema = new mongoose.Schema({
  type:       { type: String, enum: RACK_TYPES, required: true },
  rows:       { type: Number, required: true, min: 1, max: 20 },
  cols:       { type: Number, required: true, min: 1, max: 20 },
  typeConfig: {
    moduleRows: { type: Number, min: 1, max: 10 },
    moduleCols: { type: Number, min: 1, max: 10 },
    bottlesPerCell: { type: Number, min: 1, max: 20 },
    bottlesPerSection: { type: Number, min: 1, max: 30 },
    backCols: { type: Number, min: 0, max: 20 }
  },
  x:          { type: Number, default: 0 },
  y:          { type: Number, default: 0 },
});

const rackSchema = new mongoose.Schema({
  cellar:    { type: mongoose.Schema.Types.ObjectId, ref: 'Cellar', required: true, index: true },
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true, index: true },
  name:      { type: String, required: true, trim: true },
  // Simple rack fields (used when isModular is false)
  type:      { type: String, enum: RACK_TYPES, default: 'grid' },
  rows:      { type: Number, default: 4, min: 1, max: 20 },
  cols:      { type: Number, default: 8, min: 1, max: 20 },
  typeConfig: {
    moduleRows: { type: Number, min: 1, max: 10 },
    moduleCols: { type: Number, min: 1, max: 10 },
    bottlesPerCell: { type: Number, min: 1, max: 20 },
    bottlesPerSection: { type: Number, min: 1, max: 30 },
    backCols: { type: Number, min: 0, max: 20 },
    // Grid racks only: 1-indexed row numbers with headroom for a top layer
    // of bottles resting in the gaps (cols across + cols-1 on top).
    // POSITION NUMBERING CONTRACT (double-height rows): the base grid keeps
    // positions 1..rows*cols row-major EXACTLY as a plain grid — existing
    // bottles never move. Top-layer positions are APPENDED after rows*cols:
    // iterate valid double-height rows in ascending row order, each
    // contributing cols-1 positions left-to-right. Example 4x6 grid with
    // doubleHeightRows [2]: base 1..24 unchanged, top layer of row 2 =
    // positions 25..29.
    // Deliberately NOT on rackModuleSchema above — modular-rack modules
    // don't support double-height rows (out of scope; Mongoose strips the
    // key from module typeConfig).
    doubleHeightRows: { type: [Number], default: undefined }
  },
  // Modular rack fields (used when isModular is true)
  isModular: { type: Boolean, default: false },
  modules:   { type: [rackModuleSchema], default: [] },
  slots:     [slotSchema],
  // Positions the user marked as unusable (e.g. Vintec/Oeno cabinets where
  // bottle shapes mean some shelf positions can't hold a bottle). Stored as
  // a top-level list of global 1-indexed positions — NOT in slots[] (whose
  // schema requires a bottle ref) and NOT per-module (global positions cover
  // modular racks too). Position numbering stays contiguous; these are holes.
  disabledPositions: { type: [Number], default: [] },
  zones:     { type: [zoneSchema], default: [] },
  rfidTag:   { type: String },
  // Soft-delete: set when deleted, null when active
  deletedAt: { type: Date, default: null }
}, { timestamps: true, optimisticConcurrency: true });

rackSchema.index({ cellar: 1, name: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
rackSchema.index({ rfidTag: 1 }, { unique: true, sparse: true });
// NOTE: no TTL index for purging soft-deleted racks — a TTL delete can't run
// the required cascade. The 30-day purge is done by the daily retention job
// (services/cellarRetentionJob.js), which also frees rfidTags still held by
// soft-deleted racks (the unique index above has no deletedAt filter).

module.exports = mongoose.model('Rack', rackSchema);
module.exports.RACK_TYPES = RACK_TYPES;
