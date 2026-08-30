const mongoose = require('mongoose');

/**
 * What a finished import actually contained — kept briefly so a bug reported
 * days later can still be diagnosed.
 *
 * WHY THIS EXISTS. Import defects are only visible in the shape of the file
 * that triggered them, and by the time anyone reports one the file is gone:
 * parsing happens in the BROWSER (utils/importMappers), the server sees only
 * the mapped rows, and ImportSession — which does hold them — is deleted the
 * moment an import succeeds and TTLs at 7 days otherwise. Two real defects in
 * one week (a name column that never mapped, producing 131 unusable wine
 * requests; and Vivino-style "Sangiovese Blend" grape strings that disabled
 * the AI bypass for a whole export format) were each diagnosed by inference
 * from the wreckage rather than by reading the input.
 *
 * IDENTITY COLUMNS ONLY. This is deliberately NOT the user's file. Each row
 * keeps the fields that decide how a wine is identified and matched; price,
 * purchase location, personal notes and ratings are dropped on the way in
 * (see IDENTITY_FIELDS in routes/import). Those answer no import bug and
 * their absence is what keeps this archive cheap to hold and cheap to
 * explain. The row's OUTCOME rides along, because "what did the file say"
 * and "what did we do with it" are only useful together.
 *
 * GDPR: exported with the user's data, removed with their account, purged
 * with the cellar, and expired automatically by the TTL index below — the
 * same 30 days a stored label scan gets, so there is one retention story to
 * explain rather than two.
 */
const importArchiveSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  cellar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cellar',
    required: true,
    index: true,
  },

  // How the file was read — the half of an import bug that lives outside the
  // rows themselves. detectedFormat is the mapper that claimed it
  // ('cellartracker' | 'vivino' | 'generic' | …); a wrong guess here is its
  // own class of defect.
  fileName: { type: String, trim: true },
  detectedFormat: { type: String, trim: true },
  detectedEncoding: { type: String, trim: true },
  // The mapper's own parse notices, e.g. { code: 'no-identity-skipped',
  // count: 148 } — the single most direct evidence of a column that failed
  // to map, and worth keeping even when every surviving row looks fine.
  importWarnings: { type: mongoose.Schema.Types.Mixed, default: [] },

  // Rows the mapper produced, identity fields only, with what became of each.
  rows: { type: mongoose.Schema.Types.Mixed, default: [] },
  // Rows the mapper produced in total, INCLUDING any dropped by the cap
  // below — so a truncated archive can never be mistaken for a small import.
  rowCount: { type: Number, default: 0 },
  rowsTruncated: { type: Boolean, default: false },

  // The confirm summary: created / errors / errorReasons, as audited.
  summary: { type: mongoose.Schema.Types.Mixed, default: {} },

  // TTL anchor. Stamped at write time rather than derived from createdAt, so
  // the retention window is visible in the document a curator is looking at
  // and can be shortened for a single row without an index change.
  retainUntil: { type: Date, required: true },
}, { timestamps: true });

// Expire at retainUntil (expireAfterSeconds: 0 = "when this date passes").
importArchiveSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });
// Newest-first listing for a user or a cellar.
importArchiveSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('ImportArchive', importArchiveSchema);
