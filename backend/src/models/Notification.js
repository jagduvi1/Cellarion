const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      'wine_request_resolved',
      'wine_request_rejected',
      'image_approved',
      'image_rejected',
      'cellar_shared',
      'support_ticket_response',
      'new_follower',
      'discussion_reply',
      'discussion_mention',
      'drink_window_peak',
      'drink_window_ending',
      'drink_window_past',
      'wine_recommendation',
      'journal_mention',
      'restock_alert'
    ],
    required: true
  },
  title:   { type: String, required: true },
  message: { type: String, required: true },
  link:    { type: String, default: null },
  read:    { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

notificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
