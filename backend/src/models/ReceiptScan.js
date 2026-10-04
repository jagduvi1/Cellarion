const mongoose = require('mongoose');

/**
 * A scanned receipt, kept for a few days during the receipt-scan BETA so a
 * misread can be diagnosed from what the user actually uploaded.
 *
 * WHY THIS EXISTS. Receipt layouts vary by shop and country, and a wrong
 * quantity, a skipped wine or a price spread across the wrong lines can only
 * be understood next to the receipt itself and the model's raw reply. The user
 * is told before uploading (import page, privacy policy) that during the beta
 * the receipt is kept for RECEIPT_RETENTION_DAYS and then deleted.
 *
 * WHAT IS KEPT: the uploaded document (photos re-encoded with their metadata,
 * GPS included, stripped; a PDF as uploaded) in a private folder that is never
 * served (middleware/uploadsStatic refuses /receipts/), the model's raw reply,
 * and the rows that were read from it. Nothing here is shown to other users.
 *
 * GDPR: exported with the user's data (metadata and the rows read, not the
 * image bytes), removed with their account, and deleted after
 * RECEIPT_RETENTION_DAYS by services/receiptArchive's hourly sweep, which also
 * removes the files. The TTL index below is only a backstop, two days later,
 * in case the sweep has not run.
 */
const receiptScanSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // Files in the private receipts folder: { name, mediaType, bytes }.
  files: {
    type: [new mongoose.Schema({
      name: { type: String, required: true },
      mediaType: { type: String },
      bytes: { type: Number },
    }, { _id: false })],
    default: [],
  },
  model: { type: String },
  // The model's reply as text (capped), and the cleaned result returned to the
  // user — the two halves of a "what did it read, what did we make of it" bug.
  rawReply: { type: String, maxlength: 50000 },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  // 'read' | 'unreadable' | 'not_a_receipt'
  outcome: { type: String },
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  retainUntil: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

// Backstop only — the hourly sweep deletes due rows WITH their files.
receiptScanSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 2 * 86400 });

module.exports = mongoose.model('ReceiptScan', receiptScanSchema);
