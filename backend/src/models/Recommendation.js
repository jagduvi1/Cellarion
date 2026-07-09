const mongoose = require('mongoose');

const recommendationSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // External (non-user) recipient's address — third-party PII with no account
  // of its own. Retention is bounded: scrubbed after 90 days by
  // services/recommendationRetentionJob.js and immediately on sender-account
  // erasure (services/userDataRegistry.js). Kept until then only so the
  // sender's "sent" list can show who the recommendation went to.
  recipientEmail: {
    type: String,
    trim: true,
    lowercase: true,
    default: null
  },
  wine: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true
  },
  note: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  status: {
    type: String,
    enum: ['pending', 'seen', 'added-to-wishlist'],
    default: 'pending'
  },
  createdAt: { type: Date, default: Date.now }
});

recommendationSchema.index({ recipient: 1, createdAt: -1 });
recommendationSchema.index({ sender: 1, createdAt: -1 });

module.exports = mongoose.model('Recommendation', recommendationSchema);
