const mongoose = require('mongoose');

const bottleImageSchema = new mongoose.Schema({
  bottle: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bottle',
    default: null,
    index: true
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    default: null,
    index: true
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  originalUrl: {
    type: String,
    default: null
  },
  processedUrl: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['uploaded', 'processing', 'processed', 'approved', 'rejected'],
    default: 'uploaded',
    index: true
  },
  credit: {
    type: String,
    default: null,
    trim: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  visibility: {
    type: String,
    enum: ['private', 'public'],
    default: 'public'
  },
  // The uploader asked us NOT to run background removal on this photo. rembg
  // assumes a bottle on a background: on a photo of just the label, or a
  // retailer product shot, it keeps whatever "figure" it finds on the label
  // and cuts the rest away (support ticket 6a97f870, 2026-09-02 — a user's
  // label photos came back "systematically cropped"). When true the original
  // IS the kept image (processedUrl = originalUrl) and processImage /
  // reprocessAllImages / retry leave it alone.
  keepBackground: {
    type: Boolean,
    default: false
  },
  // What this image IS, so the one collection can hold two things that must
  // never be confused. 'bottle' (the default, and what every pre-existing row
  // is) = a user's photo of their bottle: gallery-eligible, wine-image-
  // eligible, public once approved. 'label-scan' = the original frame handed to
  // the AI label scanner, kept ONLY so a curator working the pending-identity
  // queue can read the label the extraction got wrong. A label-scan row is
  // always visibility:'private', never has a `bottle`, is never assignedToWine,
  // and therefore appears in no gallery and no public listing — the existing
  // { status:'approved', visibility:'public' } gates already exclude it, and
  // this field is what makes that intent explicit and queryable.
  kind: {
    type: String,
    enum: ['bottle', 'label-scan'],
    default: 'bottle',
    index: true
  },
  // WHICH FACE of the bottle this frame shows. Meaningful ONLY for
  // kind:'label-scan' — a kind:'bottle' gallery photo keeps the 'front' default
  // and nothing reads it there.
  //
  // Exists because the back label is the rescue path when the front scan came
  // back incomplete: both frames are kept as curation evidence on the same
  // pending wine (WineDefinition.scanImage / .scanImageBack), and a curator
  // being shown two photos must be told which is which — "the producer is not
  // on this one" is a different statement about a front label than about a
  // back label. Same data category, same retention, same sweeps as the front
  // scan: this field distinguishes evidence, it does not create a new class of
  // it.
  side: {
    type: String,
    enum: ['front', 'back'],
    default: 'front'
  },
  // PURPOSE-BOUND retention deadline for a kind:'label-scan' row whose wine has
  // LEFT the pending-identity queue. Stamped on the TRANSITION itself — the
  // WineDefinition post('save') hook, via
  // services/labelScanAccess.stampPromotedScanRetention, so no promoting write
  // path can forget (audit M-4) — and enforced by the daily sweep
  // (services/scanImageRetentionJob): when it passes, the file and this
  // document are deleted and WineDefinition.scanImage is nulled.
  //
  // Why a scan outlives its queue at all: a curator's completion can be WRONG,
  // and until now the label became unreadable the instant the row promoted —
  // so the only evidence that could correct it was gone (see
  // services/labelScanAccess for the full argument). The window is 7 days.
  //
  // null means NO CLOCK HAS STARTED, not "expired": every scan on a wine that
  // is still pending, and every row predating the field. Those are governed by
  // their wine's pending state and by the 30-day unattached sweep, never by
  // this field. GDPR: this REDUCES retention (a promoted wine's scan used to be
  // kept indefinitely) — it never extends it.
  retainUntil: {
    type: Date,
    default: null
  },
  assignedToWine: {
    type: Boolean,
    default: false
  },
  // SHA-256 (hex) of the stored image file bytes (the cropped image, or the
  // original when there is no crop). Set on import so a cellar export re-imported
  // by the same user reuses an already-stored identical image instead of writing
  // a duplicate copy to disk (see services/cellarImport.js).
  // Sparse: legacy/live-upload images don't have it and shouldn't bloat the index.
  contentHash: {
    type: String,
    default: null
  },
  // Reports raised by users who can SEE this image (support ticket 6a865f60,
  // 2026-08-20). Two populations need this and only one of them is abuse:
  //   - someone else's photo on a shared wine page: the only lever a viewer has
  //   - the uploader's OWN photo once it has been assigned to a wine, which
  //     makes it registry content they can no longer simply delete
  // A report never removes anything; an admin decides, using the existing
  // reject flow. Bounded at REPORTS_MAX because this array rides along on
  // every gallery read, and one determined reporter must not grow a document.
  reports: {
    type: [{
      user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      reason: { type: String, required: true, trim: true, maxlength: 40 },
      detail: { type: String, default: null, trim: true, maxlength: 500 },
      createdAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
  // First unresolved report — the admin queue sorts on it, and its presence is
  // the "needs a look" flag. Cleared when an admin approves the image as fine.
  reportedAt: {
    type: Date,
    default: null,
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

bottleImageSchema.index({ status: 1, createdAt: -1 });
bottleImageSchema.index({ bottle: 1, status: 1 });
bottleImageSchema.index({ wineDefinition: 1, assignedToWine: 1 });
// Dedup lookup on import: "does this user already have this exact image?"
bottleImageSchema.index({ uploadedBy: 1, contentHash: 1 }, { sparse: true });
// The 30-day unattached-scan sweep (services/scanImageRetentionJob.js) reads
// exactly this shape: label scans that never reached a wine.
bottleImageSchema.index({ kind: 1, wineDefinition: 1, createdAt: 1 });
// The 7-day promoted-scan expiry sweep: label scans whose grace window has run
// out.
//
// PARTIAL, not sparse (audit L-10). `retainUntil` has `default: null`, so every
// document in the collection HAS the field and a sparse index indexes all of
// them — the "small fraction" the comment claimed was the whole collection.
// A partialFilterExpression on the value is what actually restricts it to the
// promoted scans that carry a real deadline, which is also the only shape the
// sweep queries ({ kind: 'label-scan', retainUntil: { $lte: now } }).
bottleImageSchema.index(
  { kind: 1, retainUntil: 1 },
  { partialFilterExpression: { retainUntil: { $type: 'date' } } }
);

bottleImageSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('BottleImage', bottleImageSchema);
