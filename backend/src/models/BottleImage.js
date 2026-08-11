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

bottleImageSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('BottleImage', bottleImageSchema);
