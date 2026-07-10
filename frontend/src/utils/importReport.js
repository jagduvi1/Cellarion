// Pure helpers for honest import accounting: the done-screen headline math
// and the downloadable per-row CSV report.
//
// Index spaces (important):
// - The confirm endpoint receives only the importable rows (user-skipped rows
//   are filtered out client-side before POST). Its response indices —
//   `skipped[].index`, `errors[].index`, `unplaced[].sourceIndex` — all point
//   into that *submitted* array.
// - `submittedRows` is the same-order array of validation-result rows that
//   were submitted, so `submittedRows[i].index` recovers the original file
//   row (0-based) and `submittedRows[i].item` the parsed wine fields.
// - `userSkippedRows` are validation-result rows the user skipped at review
//   (never submitted).
// - `unresolvedRows` are validation-result rows the user reviewed but left
//   without any selection — unmatched (no_match) rows they ignored and error
//   rows they neither fixed nor skipped. They were NEVER submitted, so the
//   confirm response knows nothing about them; without counting them here the
//   done screen's denominator understates the review set and a partial import
//   can read as a full success.

/**
 * Summarise an import outcome for the done screen.
 *
 * @param {object|null} importResult  confirm response
 * @param {number} userSkippedCount   rows skipped by the user at review
 * @param {number} unresolvedCount    rows the user reviewed but left unselected
 *                                     (unmatched-ignored + untouched error rows)
 * @returns {{ created, totalRows, skippedCount, errorCount, unplacedCount,
 *             unresolvedCount, missedCount, fullSuccess }}
 *   - totalRows: EVERY row the user reviewed (submitted + user-skipped +
 *     unresolved) — the honest denominator for "X of Y imported".
 *   - fullSuccess: true only when every single reviewed row became a bottle and
 *     every placement landed. Any skip, error, unresolved or unplaced row makes
 *     it false.
 */
export function summariseImportOutcome(importResult, userSkippedCount = 0, unresolvedCount = 0) {
  const created = importResult?.created ?? 0;
  const backendSkipped = importResult?.skipped?.length ?? 0;
  const errorCount = importResult?.errors?.length ?? 0;
  const unplacedCount = importResult?.unplaced?.length ?? 0;
  const totalRows = (importResult?.total ?? 0) + userSkippedCount + unresolvedCount;
  const skippedCount = backendSkipped + userSkippedCount;
  const missedCount = skippedCount + errorCount + unresolvedCount;
  return {
    created,
    totalRows,
    skippedCount,
    errorCount,
    unplacedCount,
    unresolvedCount,
    missedCount,
    fullSuccess: Boolean(importResult) && missedCount === 0 && unplacedCount === 0 && created === totalRows,
  };
}

// RFC 4180-ish escaping: quote when the value contains a comma, quote or
// newline, doubling inner quotes.
export function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Pull display fields from a validation-result row (may be undefined when the
// index can't be mapped — we still emit the row rather than hide it).
const rowFields = (row) => ({
  index: row ? row.index + 1 : '',
  wineName: row?.item?.wineName || '',
  producer: row?.item?.producer || '',
  vintage: row?.item?.vintage || '',
});

/**
 * Flatten every non-created outcome into report rows.
 * Outcomes: 'skipped' (backend + user-skipped), 'not imported' (reviewed but
 * left unselected), 'error', 'unplaced' (imported but no rack slot — still
 * worth telling the user about). Rows are sorted by original file row number.
 */
export function buildOutcomeRows({ importResult, submittedRows = [], userSkippedRows = [], unresolvedRows = [], userSkippedReason = 'Skipped during review', unresolvedReason = 'No match selected' }) {
  const rows = [];

  for (const s of importResult?.skipped || []) {
    rows.push({ ...rowFields(submittedRows[s.index]), outcome: 'skipped', reason: s.reason || '' });
  }
  for (const r of userSkippedRows) {
    rows.push({ ...rowFields(r), outcome: 'skipped', reason: userSkippedReason });
  }
  // Rows the user reviewed but never resolved — never submitted, so they carry
  // no backend outcome. An error row keeps its own validation reason; an
  // ignored no-match row gets the generic "no selection" reason.
  for (const r of unresolvedRows) {
    rows.push({
      ...rowFields(r),
      outcome: 'not imported',
      reason: (r?.status === 'error' && r?.error) ? r.error : unresolvedReason,
    });
  }
  for (const e of importResult?.errors || []) {
    rows.push({ ...rowFields(submittedRows[e.index]), outcome: 'error', reason: e.reason || '' });
  }
  for (const u of importResult?.unplaced || []) {
    const mapped = u.sourceIndex !== null && u.sourceIndex !== undefined ? submittedRows[u.sourceIndex] : undefined;
    const where = u.rackName ? `rack "${u.rackName}"` : 'rack';
    rows.push({
      ...rowFields(mapped),
      outcome: 'unplaced',
      reason: `Imported, but not placed in ${where}: ${u.reason || 'no free slot'}`,
    });
  }

  return rows.sort((a, b) => (a.index === '' ? Infinity : a.index) - (b.index === '' ? Infinity : b.index));
}

/**
 * Build the downloadable CSV report: one summary line, a header row, then
 * one row per non-created outcome (skipped / error / unplaced). Created rows
 * are omitted on purpose — the report is the "what to look at" list.
 *
 * @returns {string} CSV text (no BOM; the caller prepends one for Excel)
 */
export function buildImportReportCsv({ importResult, submittedRows = [], userSkippedRows = [], unresolvedRows = [], userSkippedReason, unresolvedReason } = {}) {
  const { created, totalRows, skippedCount, errorCount, unplacedCount, unresolvedCount } =
    summariseImportOutcome(importResult, userSkippedRows.length, unresolvedRows.length);

  // The summary line is intentionally left unquoted (it's for humans; the
  // leading '#' marks it as a comment for anyone re-parsing the file). The
  // "not imported" clause only appears when there were unresolved rows, so a
  // clean import's summary stays byte-for-byte what it always was.
  const parts = [
    `${skippedCount} skipped`,
    `${errorCount} errors`,
    ...(unresolvedCount > 0 ? [`${unresolvedCount} not imported`] : []),
    `${unplacedCount} imported but unplaced`,
  ];
  const summary = `# Import report: ${created} of ${totalRows} rows imported (${parts.join(', ')})`;
  const header = 'index,wineName,producer,vintage,outcome,reason';
  const lines = buildOutcomeRows({ importResult, submittedRows, userSkippedRows, unresolvedRows, userSkippedReason, unresolvedReason })
    .map(r => [r.index, r.wineName, r.producer, r.vintage, r.outcome, r.reason].map(csvEscape).join(','));

  return [summary, header, ...lines].join('\r\n') + '\r\n';
}
