const mongoose = require('mongoose');

const slotSchema = new mongoose.Schema({
  position: { type: Number, required: true },
  bottle:   { type: mongoose.Schema.Types.ObjectId, ref: 'Bottle', required: true }
}, { _id: false });

const rackSchema = new mongoose.Schema({
  cellar:    { type: mongoose.Schema.Types.ObjectId, ref: 'Cellar', required: true, index: true },
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true, index: true },
  name:      { type: String, required: true, trim: true },
  rows:      { type: Number, default: 4, min: 1, max: 20 },
  cols:      { type: Number, default: 8, min: 1, max: 20 },
  slots:     [slotSchema],
  // Soft-delete: set when deleted, null when active
  deletedAt: { type: Date, default: null }
}, { timestamps: true, optimisticConcurrency: true });

rackSchema.index({ cellar: 1, name: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
// TTL: auto-purge soft-deleted racks after 30 days
rackSchema.index(
  { deletedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { deletedAt: { $ne: null } } }
);

module.exports = mongoose.model('Rack', rackSchema);
