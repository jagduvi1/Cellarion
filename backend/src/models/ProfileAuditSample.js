const mongoose = require('mongoose');

/**
 * ProfileAuditSample — one recorded spot-check of published AI profiles
 * (somm gap report 2026-08-18, item 5): sample_published_profiles asks the
 * curator to track corrections-per-sample across weeks, and that error rate
 * decides whether heavier anti-hallucination work is worth building — but
 * the number previously lived only in chat. This is the durable tally the
 * ~2026-09-15 scaling re-analysis reads.
 *
 * Written by the record_profile_audit MCP tool; the tool's response computes
 * the running rate from recent rows so the trend is visible at write time.
 */
const profileAuditSampleSchema = new mongoose.Schema({
  sampleSize: {
    type: Number,
    required: true,
    min: 1,
    max: 100
  },
  corrections: {
    type: Number,
    required: true,
    min: 0
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [500, 'Notes too long']
  },
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recordedAt: {
    type: Date,
    default: Date.now
  }
});

profileAuditSampleSchema.index({ recordedAt: -1 });

module.exports = mongoose.model('ProfileAuditSample', profileAuditSampleSchema);
