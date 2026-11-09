const mongoose = require('mongoose');

/**
 * AppellationReviewSkip — marks an unmatched-appellation string as reviewed
 * and REJECTED, so it stops resurfacing in the review queue
 * (services/taxonomyReview.listUnmatchedAppellations filters on it).
 *
 * The queue is a live aggregate over wine rows — without a persisted review,
 * a string judged "not an appellation" (a quality tier, a fantasy name, a
 * label slogan) would reappear on every visit forever (the same gap
 * PriceTrackingSkip closes for the price queue).
 *
 * `normalizedKey` is the queue's own group key (normalizeAppellationKey of
 * the tier-stripped string), and the listing judges coverage through the
 * resolver's candidateKeys exactly as it does for curated docs — so one
 * dismissal also silences the decorated variants that fold onto it.
 *
 * Written by POST /api/admin/taxonomy/appellations/unmatched/dismiss and the
 * dismiss_appellation MCP tool; deleted by their restore counterparts.
 */
const appellationReviewSkipSchema = new mongoose.Schema({
  normalizedKey: {
    type: String,
    required: true,
    trim: true
  },
  // Majority display spelling at dismissal time — the label an admin sees in
  // the dismissed list; the KEY is what suppresses.
  name: {
    type: String,
    trim: true,
    maxlength: [200, 'Name too long']
  },
  reason: {
    type: String,
    trim: true,
    maxlength: [500, 'Reason too long']
  },
  skippedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  skippedAt: {
    type: Date,
    default: Date.now
  }
});

appellationReviewSkipSchema.index({ normalizedKey: 1 }, { unique: true });

module.exports = mongoose.model('AppellationReviewSkip', appellationReviewSkipSchema);
