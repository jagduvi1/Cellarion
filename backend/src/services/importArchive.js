// What an import leaves behind for diagnosis: the failure reasons grouped for
// its audit row, and a short-lived archive of the identity columns of the
// file (models/ImportArchive).
//
// Both keep the user's data out of what is kept: the audit gets reasons with
// counts and no wine names, the archive gets the columns that decide how a
// wine is identified and nothing else.
//
// Caller: POST /api/bottles/import/confirm in routes/import.js, which
// re-exports summariseReasons for its test.

const ImportArchive = require('../models/ImportArchive');
// Parse-time warnings are bounded before they are stored.
const { sanitizeImportWarnings } = require('../utils/importWarnings');

// Distinct failure reasons kept in one import's audit row, and the length each
// is truncated to. Enough to name every failure mode a real file hits without
// letting a pathological one bloat the document.
const AUDIT_REASON_MAX_KINDS = 12;
const AUDIT_REASON_MAX_LEN = 160;

/**
 * Group per-row {reason} entries into { reason: count } for the audit.
 *
 * Deliberately reason-only: the row's wine name, producer and notes are the
 * user's data and the audit needs the failure MODE, not the record. Messages
 * that embed a caught err.message can vary per row, so they are truncated and
 * the tail is folded into one "+N more" bucket rather than dropped silently —
 * a cap that hides its own truncation is how you end up trusting a partial
 * picture.
 */
function summariseReasons(entries) {
  const counts = new Map();
  for (const e of entries) {
    const raw = (e && typeof e.reason === 'string' && e.reason.trim()) ? e.reason.trim() : '(no reason recorded)';
    const key = raw.length > AUDIT_REASON_MAX_LEN ? `${raw.slice(0, AUDIT_REASON_MAX_LEN)}…` : raw;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = ranked.slice(0, AUDIT_REASON_MAX_KINDS);
  const out = Object.fromEntries(kept);
  const spilled = ranked.slice(AUDIT_REASON_MAX_KINDS);
  if (spilled.length) {
    out[`+${spilled.length} more reason kind(s)`] = spilled.reduce((s, [, n]) => s + n, 0);
  }
  return out;
}

// ── Import archive ──────────────────────────────────────────────────────────
//
// The identity columns kept from each row, and nothing else. These are the
// fields that decide how a wine is identified, matched and minted — every
// import defect so far has lived in one of them. Price, purchase location,
// notes and ratings are deliberately absent: they answer no import bug, and
// leaving them out is what makes a 30-day archive of other people's cellars
// a small thing rather than a large one. See models/ImportArchive.
const IDENTITY_FIELDS = [
  'wineName', 'producer', 'vintage', 'country', 'region', 'appellation',
  'classification', 'type', 'grapes', 'quantity', 'bottleSize',
];
// One import is bounded by MAX_IMPORT_SIZE (2,000 rows); the archive keeps
// the head of anything larger so a pathological file cannot write an
// unbounded document. rowsTruncated + rowCount keep the omission visible.
const ARCHIVE_ROW_CAP = 2000;
// Retention window for the archive. Matches the unattached label-scan sweep
// (services/scanImageRetentionJob) so the app has ONE retention story to
// explain, not two.
const IMPORT_ARCHIVE_DAYS = 30;

/**
 * Project one import row down to its identity columns plus its outcome.
 * `outcome` is what the row's SELECTION resolved to — matched an existing
 * wine, minted a new one, or filed a request ('other' when it had none). A
 * confirmed AI proposal records what /confirm resolved it to: 'created' only
 * when this row minted the wine, 'matched' when it found one, 'unresolved'
 * when it found none. Any other row that errored keeps its selection's
 * outcome. "What the file said" and "what we did with it" are only diagnostic
 * together.
 */
function archiveRow(item, outcome) {
  const row = { outcome };
  for (const f of IDENTITY_FIELDS) {
    const v = item[f];
    if (v === undefined || v === null || v === '') continue;
    row[f] = Array.isArray(v) ? v.slice(0, 20).map((g) => String(g).slice(0, 80)) : String(v).slice(0, 200);
  }
  return row;
}

/**
 * Keep what an import's file contained, identity columns only, for
 * IMPORT_ARCHIVE_DAYS (models/ImportArchive). The rows are projected through
 * archiveRow, never stored raw.
 *
 *   meta       the request body: fileName, detectedFormat, detectedEncoding
 *              and importWarnings are read from it, each bounded
 *   outcomeOf  (item, index) → what the row's selection resolved to
 *   summary    () → the import's counts; called here so that a failure to
 *              build them is a failed archive, not a failed import
 *
 * NOT awaited by its caller, and it never throws: the import is finished and
 * audited by the time this runs, so a diagnostic copy must not delay the
 * response, and a slow or failing write must not turn a successful import
 * into an error. Caller: POST /api/bottles/import/confirm.
 */
function writeImportArchive({ userId, cellarId, meta, items, outcomeOf, summary }) {
  try {
    const rows = items.slice(0, ARCHIVE_ROW_CAP).map((item, i) => archiveRow(item, outcomeOf(item, i)));
    ImportArchive.create({
      user: userId,
      cellar: cellarId,
      fileName: typeof meta.fileName === 'string' ? meta.fileName.slice(0, 260) : undefined,
      detectedFormat: typeof meta.detectedFormat === 'string' ? meta.detectedFormat.slice(0, 40) : undefined,
      detectedEncoding: typeof meta.detectedEncoding === 'string' ? meta.detectedEncoding.slice(0, 40) : undefined,
      importWarnings: sanitizeImportWarnings(meta.importWarnings),
      rows,
      rowCount: items.length,
      rowsTruncated: items.length > ARCHIVE_ROW_CAP,
      summary: summary(),
      retainUntil: new Date(Date.now() + IMPORT_ARCHIVE_DAYS * 24 * 60 * 60 * 1000),
    }).catch((err) => {
      console.warn('[import] archive write failed (non-fatal):', err.message);
    });
  } catch (err) {
    // Projection/build failure — the create above never launched.
    console.warn('[import] archive build failed (non-fatal):', err.message);
  }
}

module.exports = {
  summariseReasons,
  writeImportArchive,
};
