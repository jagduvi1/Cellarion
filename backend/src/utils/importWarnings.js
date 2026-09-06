/**
 * Parse-time import warnings, bounded (audit 2026-09 D13-12).
 *
 * The client sends the notices its parser produced (CellarTracker truncation,
 * encoding, table choice) so a resumed import can show the same banner. They
 * arrived as free Mixed values and were stored as-is — up to the 8 MB import
 * body per row — in ImportSession and ImportArchive. Keep the three fields the
 * banner reads, each capped, and drop everything else.
 */
const MAX_WARNINGS = 20;
const CODE_MAX = 40;
const SAMPLE_MAX = 200;

function sanitizeImportWarnings(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_WARNINGS).map((w) => {
    if (!w || typeof w !== 'object') return null;
    const out = {};
    if (typeof w.code === 'string' && w.code.trim()) out.code = w.code.trim().slice(0, CODE_MAX);
    if (typeof w.count === 'number' && Number.isFinite(w.count)) out.count = w.count;
    if (typeof w.sample === 'string') out.sample = w.sample.slice(0, SAMPLE_MAX);
    return out.code ? out : null;
  }).filter(Boolean);
}

module.exports = { sanitizeImportWarnings, MAX_WARNINGS, CODE_MAX, SAMPLE_MAX };
