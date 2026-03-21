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
    bottlesPerSection: { type: Number, min: 1, max: 30 }
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
    bottlesPerSection: { type: Number, min: 1, max: 30 }
  },
  // Modular rack fields (used when isModular is true)
  isModular: { type: Boolean, default: false },
  modules:   { type: [rackModuleSchema], default: [] },
  slots:     [slotSchema],
  rfidTag:   { type: String },
  // Soft-delete: set when deleted, null when active
  deletedAt: { type: Date, default: null }
}, { timestamps: true, optimisticConcurrency: true });

rackSchema.index({ cellar: 1, name: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
rackSchema.index({ rfidTag: 1 }, { unique: true, sparse: true });
// TTL: auto-purge soft-deleted racks after 30 days
rackSchema.index(
  { deletedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { deletedAt: { $ne: null } } }
);

module.exports = mongoose.model('Rack', rackSchema);
module.exports.RACK_TYPES = RACK_TYPES;
