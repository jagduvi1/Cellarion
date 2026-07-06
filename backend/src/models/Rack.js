const mongoose = require('mongoose');

const RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf'];

const slotSchema = new mongoose.Schema({
  position: { type: Number, required: true },
  bottle:   { type: mongoose.Schema.Types.ObjectId, ref: 'Bottle', required: true },
  rfidTag:  { type: String }
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
    backCols: { type: Number, min: 0, max: 20 }
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
  rfidTag:   { type: String },
  // Soft-delete: set when deleted, null when active
  deletedAt: { type: Date, default: null }
}, { timestamps: true, optimisticConcurrency: true });

rackSchema.index({ cellar: 1, name: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
rackSchema.index({ rfidTag: 1 }, { unique: true, sparse: true });
// NOTE: no TTL auto-purge of soft-deleted racks. The previous index used
// partialFilterExpression { deletedAt: { $ne: null } }, which MongoDB rejects
// ($ne is unsupported in partial indexes), so syncIndexes failed every boot
// and the index never existed — the purge has never actually run. Re-adding it
// needs (a) the supported predicate { deletedAt: { $type: 'date' } } AND (b) a
// cascade that clears bottle rack references first, or TTL deletion would
// orphan them (see CODE_AUDIT — same class as the cellar-purge finding).

module.exports = mongoose.model('Rack', rackSchema);
module.exports.RACK_TYPES = RACK_TYPES;
