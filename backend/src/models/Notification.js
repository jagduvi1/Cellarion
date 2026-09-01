const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // The user who triggered this notification (follower, replier, mentioner, …),
  // when there is one. The title/message denormalize their display name, so this
  // ref lets GDPR erasure remove notifications delivered to OTHERS that name a
  // departing user. Null for system notifications (drink-window, admin, etc.).
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
    sparse: true
  },
  type: {
    type: String,
    enum: [
      'wine_request_resolved',
      'wine_request_rejected',
      'wine_report_resolved',
      'wine_report_dismissed',
      'image_approved',
      'image_rejected',
      'cellar_shared',
      'cellar_ownership_received',
      'support_ticket_response',
      'new_follower',
      'discussion_reply',
      'discussion_mention',
      'drink_window_peak',
      'drink_window_ending',
      'drink_window_past',
      'open_bottle_expiring',
      'reservation_due',
      'wine_recommendation',
      'journal_mention',
      'restock_alert',
      'price_tracked',
      'price_tracking_declined',
      'ai_budget_request',
      'ai_budget_approved',
      'ai_budget_denied',
      'climate_alert',
      'climate_recovered',
      'climate_offline',
      'registry_health',
      'owner_inquiry',
      'owner_inquiry_response',
      'owner_inquiry_resolved',
      // Registry-data contributions. Every other submitter-facing queue
      // (wine requests, wine reports, images, price requests) tells the
      // submitter what happened; these two were the gap — a decided
      // proposal recorded its rejectReason where only a GDPR export could
      // reach it.
      'registry_key_decided',
      'registry_value_decided',
      // A member asked for a forum language section; same principle as the
      // two above — whoever asked gets told what was decided.
      'forum_language_decided'
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
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90-day TTL

module.exports = mongoose.model('Notification', notificationSchema);
