const mongoose = require('mongoose');

const restockAlertSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // The wine that was consumed and triggered the alert
  wine: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true
  },
  wineName: { type: String, required: true },
  wineProducer: { type: String, default: '' },
  wineType: { type: String, default: '' },
  vintage: { type: String, default: '' },
  // Wine definition IDs that were checked for similarity
  similarWineIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition'
  }],
  status: {
    type: String,
    enum: ['active', 'dismissed', 'resolved'],
    default: 'active',
    index: true
  },
  // The bottle that resolved the alert (when user buys a similar wine)
  resolvedByBottle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bottle',
    default: null
  },
  dismissedAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

restockAlertSchema.index({ user: 1, status: 1, createdAt: -1 });
// For auto-resolve: find active alerts where similarWineIds includes the new wine
restockAlertSchema.index({ user: 1, status: 1, similarWineIds: 1 });

module.exports = mongoose.model('RestockAlert', restockAlertSchema);
