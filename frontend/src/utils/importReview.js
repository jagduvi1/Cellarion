// Pure helpers for the import review step's trickier state transitions.
// Extracted from ImportBottles.js so the "did the retry keep the right wine",
// "which rows still need AI", "what survives a session resume" and "is a budget
// request still pending" decisions are unit-testable without rendering the page.

/**
 * Rows the bulk "Retry AI lookups" should re-validate: those still needing an
 * AI look-up (aiSkipped fallback or an outright no_match) that the user has NOT
 * already resolved. A committed decision — skip, request, or a manual search
 * match — must be left alone so the retry never re-spends AI budget on a row
 * the user already settled. An auto-selected fuzzy fallback is NOT a committed
 * decision: upgrading it to a real AI match is the whole point of the retry.
 *
 * @param {Array} results        validation-result rows
 * @param {object} selections    { [index]: wineId | 'skip' | 'request' }
 * @param {object} manualWines   { [index]: wineObject } from the search modal
 * @returns {Array} the subset of `results` to retry
 */
export function rowsNeedingAiRetry(results, selections = {}, manualWines = {}) {
  return (results || []).filter((r) => {
    if (!(r.aiSkipped || r.status === 'no_match')) return false;
    const sel = selections[r.index];
    if (sel === 'skip' || sel === 'request') return false; // user decided
    if (manualWines[r.index] != null) return false;        // user matched by hand
    return true;
  });
}

/**
 * Reconcile selections after a retry batch rewrites some rows.
 *
 * For each updated row that now carries a usable match, fill an empty selection
 * OR replace a stale one whose wine has vanished from the refreshed matches
 * (the fuzzy-auto-pick → AI-upgrade case: the row shows the new AI badge, so it
 * must import the new wine, not the old fuzzy one). Deliberate user choices —
 * skip, request, or a manual search match — are always preserved, even when the
 * chosen wine is absent from the refreshed matches.
 *
 * @param {object} prevSelections   current selections map
 * @param {Map} updatedByIndex      Map(originalIndex -> new result row)
 * @param {object} manualWines      { [index]: wineObject } from the search modal
 * @returns {object} the next selections map
 */
export function reconcileRetrySelections(prevSelections, updatedByIndex, manualWines = {}) {
  const next = { ...(prevSelections || {}) };
  for (const [idx, r] of updatedByIndex) {
    const hasMatch =
      (r.status === 'exact' || r.status === 'fuzzy' || r.status === 'ai_match') &&
      Array.isArray(r.matches) && r.matches.length > 0;
    // ai_new: the AI identified a wine the registry doesn't have — the usable
    // outcome is the 'create' proposal rather than a wineId.
    const hasProposal = r.status === 'ai_new' && r.aiProposed != null;
    if (!hasMatch && !hasProposal) continue;

    const cur = next[idx];
    if (cur === 'skip' || cur === 'request') continue; // deliberate decision
    if (manualWines[idx] != null) continue;            // manual search match

    if (hasMatch) {
      const stillPresent = cur != null && r.matches.some((m) => m.wineId === cur);
      if (cur == null || !stillPresent) {
        next[idx] = r.matches[0].wineId;
      }
    } else {
      // Same replace-a-stale-pick rule as matches: fill an empty selection, or
      // replace a fuzzy pick the refreshed row no longer offers, with 'create'.
      const stillPresent = cur === 'create' ||
        (cur != null && Array.isArray(r.matches) && r.matches.some((m) => m.wineId === cur));
      if (cur == null || !stillPresent) {
        next[idx] = 'create';
      }
    }
  }
  return next;
}

/**
 * Merge a completed retry batch into the results array. Applied per batch (as
 * each completes) so a later failure can't discard batches that already
 * succeeded.
 *
 * @param {Array} results         current results
 * @param {Map} batchUpdates      Map(originalIndex -> new result row)
 * @returns {Array} results with the batch's rows replaced in place
 */
export function mergeRetryResults(results, batchUpdates) {
  return (results || []).map((r) => batchUpdates.get(r.index) || r);
}

/**
 * Merge one validate batch's server-computed summary into the running
 * combined summary, returning a NEW object (the previous one may already be
 * committed to React state). Numeric counters add up; the boolean-ish
 * aiBudgetExhausted flag survives as a truthy number the same way the old
 * in-place merge handled it.
 *
 * @param {object|null} base   running combined summary (null on first batch)
 * @param {object} add         this batch's summary from the server
 * @returns {object} the next combined summary
 */
export function mergeValidateSummaries(base, add) {
  if (!base) return { ...(add || {}) };
  const next = { ...base };
  for (const key of Object.keys(add || {})) {
    next[key] = (next[key] || 0) + (add[key] || 0);
  }
  return next;
}

/**
 * The auto-selections for a set of freshly validated rows: exact, fuzzy and
 * AI-identified matches pre-select their top match. Pure per-row rule, so it
 * can be applied batch-by-batch and the union over all batches equals one
 * pass over the full results array.
 *
 * @param {Array} rows  validation-result rows (global indices)
 * @returns {object} { [index]: wineId }
 */
export function autoSelectionsFor(rows) {
  const sel = {};
  for (const r of rows || []) {
    if (
      (r.status === 'exact' || r.status === 'fuzzy' || r.status === 'ai_match') &&
      Array.isArray(r.matches) && r.matches.length > 0
    ) {
      sel[r.index] = r.matches[0].wineId;
    } else if (r.status === 'ai_new' && r.aiProposed != null) {
      // AI-identified NEW wines default to 'create' — the wine is minted at
      // /confirm, so leaving the row unselected would silently drop it from
      // the import.
      sel[r.index] = 'create';
    }
  }
  return sel;
}

/**
 * Whether a stored partial-validate marker still applies to the current
 * upload. Identity-compares the parsed-items array (a new file parse creates
 * a new array) and the Vivino mode flags (prepareImportItems is pure, so the
 * same inputs reproduce the exact prepared rows the partial run validated).
 *
 * @param {object|null} marker  { parsedItems, vivinoScanHistory, vivinoImportMode, doneUpTo }
 * @param {Array} parsedItems
 * @param {boolean} vivinoScanHistory
 * @param {string} vivinoImportMode
 * @returns {boolean}
 */
export function canResumeValidation(marker, parsedItems, vivinoScanHistory, vivinoImportMode) {
  return Boolean(
    marker &&
    marker.doneUpTo > 0 &&
    marker.parsedItems === parsedItems &&
    marker.vivinoScanHistory === vivinoScanHistory &&
    marker.vivinoImportMode === vivinoImportMode
  );
}

/**
 * The cosmetic + warning metadata to restore when resuming a saved session.
 * Kept pure (and defensive about missing/malformed fields) so the resume path
 * re-renders the ct-truncated banner and the encoding/table/fallback notes.
 */
export function restoreSessionMeta(session) {
  return {
    importWarnings: Array.isArray(session?.importWarnings) ? session.importWarnings : [],
    detectedEncoding: session?.detectedEncoding || null,
    ctTable: session?.ctTable || null,
    ctTextFallback: Array.isArray(session?.ctTextFallback) ? session.ctTextFallback : [],
  };
}

/**
 * After a budget-status refresh, decide the local request-flag state. Once the
 * server reports no pending request, a sticky local 'requested' must be
 * released so the user can ask again after an admin decides — the old code left
 * it stuck forever.
 */
export function nextAiBudgetRequestState(prev, status) {
  if (prev === 'requested' && status && !status.pendingRequest) return 'idle';
  return prev;
}

/**
 * Whether to show the "request pending" label: true when the server says a
 * request is open, or when we've optimistically submitted one this session and
 * no refresh has cleared it yet.
 */
export function isAiBudgetRequestPending(status, requestState) {
  return Boolean(status?.pendingRequest) || requestState === 'requested';
}
