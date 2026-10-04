/**
 * Receipt scan → import rows.
 *
 * POST /api/bottles/import/receipt answers one row per WINE LINE with a
 * `quantity`; the import page works with one row per BOTTLE (the same
 * expansion utils/importMappers does for a CSV with a quantity column). The
 * receipt's shop, date and currency are already on every row server-side.
 */

const MAX_BOTTLES = 1000; // well above any real receipt; guards the page from a runaway reply

/**
 * One row per bottle, in receipt order. `quantity` is dropped from the rows.
 * Receipts often leave the vintage out: such a row is marked exactly as a CSV
 * row without a vintage is (utils/importMappers) — NV plus `vintageMissing` —
 * so the review screen offers a field to type the year.
 */
export function expandReceiptItems(items) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || (!item.wineName && !item.producer)) continue;
    const { quantity, ...row } = item;
    if (!row.vintage) {
      row.vintage = 'NV';
      row.vintageMissing = true;
    }
    const n = Math.max(1, Math.min(Number.isInteger(quantity) ? quantity : 1, MAX_BOTTLES));
    for (let i = 0; i < n && rows.length < MAX_BOTTLES; i++) rows.push({ ...row });
  }
  return rows;
}

/**
 * Group skipped receipt lines by reason, most frequent first:
 * [{ reason: 'beer', count: 2, lines: ['LAGER 33CL', 'IPA 50CL'] }, …]
 */
export function groupSkippedLines(skipped) {
  const byReason = new Map();
  for (const s of Array.isArray(skipped) ? skipped : []) {
    if (!s?.line) continue;
    const reason = s.reason || 'other';
    const group = byReason.get(reason) || { reason, count: 0, lines: [] };
    group.count += 1;
    group.lines.push(s.line);
    byReason.set(reason, group);
  }
  return [...byReason.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * The import page's error text for a failed scan. `data` is the JSON body (may
 * be empty), `status` the HTTP status. Returns an i18n key and its values.
 */
export function receiptErrorKey(status, data = {}) {
  const code = data?.code;
  if (code === 'not_a_receipt') return { key: 'importBottles.receipt.errors.notReceipt' };
  if (code === 'unreadable') return { key: 'importBottles.receipt.errors.unreadable' };
  if (code === 'ai_budget_exhausted') return { key: 'importBottles.receipt.errors.budget' };
  if (code === 'demo_ai_disabled') return { key: 'importBottles.receipt.errors.demo' };
  if (code === 'ai_unavailable') return { key: 'importBottles.receipt.errors.unavailable' };
  if (code === 'pdf_unsupported') return { key: 'importBottles.receipt.errors.pdfUnsupported' };
  if (code === 'scan_busy') return { key: 'importBottles.receipt.errors.busy' };
  if (status === 429) return { key: 'importBottles.receipt.errors.tooMany' };
  // A 400 carries a specific, already-readable reason (too large, too many
  // pages, wrong file type).
  if (status === 400 && data?.error) return { key: 'importBottles.receipt.errors.withReason', values: { reason: data.error } };
  return { key: 'importBottles.receipt.errors.generic' };
}
