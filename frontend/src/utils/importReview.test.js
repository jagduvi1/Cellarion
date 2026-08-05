import {
  rowsNeedingAiRetry,
  reconcileRetrySelections,
  mergeRetryResults,
  restoreSessionMeta,
  nextAiBudgetRequestState,
  isAiBudgetRequestPending,
} from './importReview';

// ---------------------------------------------------------------------------
// BUG 5(a) — the bulk "Retry AI lookups" filter must not re-spend budget on
// rows the user already resolved.
// ---------------------------------------------------------------------------
describe('rowsNeedingAiRetry', () => {
  const results = [
    { index: 0, status: 'no_match', aiSkipped: false }, // untouched no-match → retry
    { index: 1, status: 'fuzzy', aiSkipped: true },     // aiSkipped fuzzy auto-pick → retry (upgrade)
    { index: 2, status: 'no_match', aiSkipped: false }, // user requested → skip
    { index: 3, status: 'no_match', aiSkipped: false }, // user skipped → skip
    { index: 4, status: 'no_match', aiSkipped: false }, // user matched by hand → skip
    { index: 5, status: 'exact', aiSkipped: false },    // already matched → not eligible
    { index: 6, status: 'fuzzy', aiSkipped: false },    // plain fuzzy (had its AI shot) → not eligible
  ];
  const selections = { 1: 'autoFuzzyWine', 2: 'request', 3: 'skip', 4: 'manualWine', 5: 'exactWine' };
  const manualWines = { 4: { _id: 'manualWine' } };

  it('retries only unresolved aiSkipped / no_match rows, upgrading auto-fuzzy picks', () => {
    const rows = rowsNeedingAiRetry(results, selections, manualWines);
    expect(rows.map(r => r.index)).toEqual([0, 1]);
  });

  it('treats a bare no-match row (no selection) as needing retry', () => {
    expect(rowsNeedingAiRetry([{ index: 0, status: 'no_match' }], {}, {}).map(r => r.index)).toEqual([0]);
  });

  it('excludes a manually matched row even when it is still status no_match', () => {
    const rows = rowsNeedingAiRetry(
      [{ index: 0, status: 'no_match' }],
      { 0: 'someWineId' },
      { 0: { _id: 'someWineId' } }
    );
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG 1 — after a retry replaces a row's result, a stale auto-selection that no
// longer exists in the refreshed matches must be replaced; deliberate choices
// must be preserved.
// ---------------------------------------------------------------------------
describe('reconcileRetrySelections', () => {
  it('replaces a stale fuzzy auto-pick with the new AI match (BUG 1 core)', () => {
    // Row 5 was fuzzy+aiSkipped and auto-selected oldWine; retry upgraded it to
    // an ai_match for a DIFFERENT wine, so oldWine is gone from the matches.
    const prev = { 5: 'oldWine' };
    const updated = new Map([
      [5, { index: 5, status: 'ai_match', matches: [{ wineId: 'newWine' }] }],
    ]);
    expect(reconcileRetrySelections(prev, updated, {})[5]).toBe('newWine');
  });

  it('preserves a manual search match even when it is absent from the refreshed matches', () => {
    const prev = { 7: 'manualWine' };
    const manualWines = { 7: { _id: 'manualWine' } };
    const updated = new Map([
      [7, { index: 7, status: 'ai_match', matches: [{ wineId: 'aiWine' }] }],
    ]);
    expect(reconcileRetrySelections(prev, updated, manualWines)[7]).toBe('manualWine');
  });

  it('keeps a selection that is still present among the refreshed matches', () => {
    const prev = { 3: 'keepWine' };
    const updated = new Map([
      [3, { index: 3, status: 'fuzzy', matches: [{ wineId: 'topWine' }, { wineId: 'keepWine' }] }],
    ]);
    expect(reconcileRetrySelections(prev, updated, {})[3]).toBe('keepWine');
  });

  it('fills an empty selection with the new top match', () => {
    const updated = new Map([
      [9, { index: 9, status: 'ai_match', matches: [{ wineId: 'foundWine' }] }],
    ]);
    expect(reconcileRetrySelections({}, updated, {})[9]).toBe('foundWine');
  });

  it('never overrides an explicit skip / request', () => {
    const prev = { 1: 'skip', 2: 'request' };
    const updated = new Map([
      [1, { index: 1, status: 'ai_match', matches: [{ wineId: 'x' }] }],
      [2, { index: 2, status: 'ai_match', matches: [{ wineId: 'y' }] }],
    ]);
    const next = reconcileRetrySelections(prev, updated, {});
    expect(next[1]).toBe('skip');
    expect(next[2]).toBe('request');
  });

  it('leaves a selection untouched when the retry found no match', () => {
    const prev = { 4: 'oldWine' };
    const updated = new Map([[4, { index: 4, status: 'no_match', matches: [] }]]);
    expect(reconcileRetrySelections(prev, updated, {})[4]).toBe('oldWine');
  });

  it('fills an empty selection with create when the retry upgraded the row to ai_new', () => {
    const updated = new Map([
      [6, { index: 6, status: 'ai_new', aiProposed: { name: 'N', producer: 'P' }, matches: [] }],
    ]);
    expect(reconcileRetrySelections({}, updated, {})[6]).toBe('create');
  });

  it('replaces a stale fuzzy pick with create when the ai_new row no longer offers that wine', () => {
    const prev = { 6: 'oldWine' };
    const updated = new Map([
      [6, { index: 6, status: 'ai_new', aiProposed: { name: 'N', producer: 'P' }, matches: [{ wineId: 'other' }] }],
    ]);
    expect(reconcileRetrySelections(prev, updated, {})[6]).toBe('create');
  });

  it('keeps a fuzzy pick that the ai_new row still offers as a candidate', () => {
    const prev = { 6: 'keepWine' };
    const updated = new Map([
      [6, { index: 6, status: 'ai_new', aiProposed: { name: 'N', producer: 'P' }, matches: [{ wineId: 'keepWine' }] }],
    ]);
    expect(reconcileRetrySelections(prev, updated, {})[6]).toBe('keepWine');
  });

  it('never overrides skip / request / manual match with create', () => {
    const prev = { 1: 'skip', 2: 'request', 3: 'manualWine' };
    const manualWines = { 3: { _id: 'manualWine' } };
    const row = (i) => [i, { index: i, status: 'ai_new', aiProposed: { name: 'N', producer: 'P' }, matches: [] }];
    const next = reconcileRetrySelections(prev, new Map([row(1), row(2), row(3)]), manualWines);
    expect(next[1]).toBe('skip');
    expect(next[2]).toBe('request');
    expect(next[3]).toBe('manualWine');
  });
});

// ---------------------------------------------------------------------------
// BUG 5(b) — batches must be merged as they complete so a later failure keeps
// the earlier work.
// ---------------------------------------------------------------------------
describe('mergeRetryResults', () => {
  it('applies successive batches without losing earlier ones', () => {
    const results = [
      { index: 0, status: 'no_match' },
      { index: 1, status: 'fuzzy' },
      { index: 2, status: 'no_match' },
    ];
    const afterB1 = mergeRetryResults(results, new Map([[0, { index: 0, status: 'ai_match' }]]));
    expect(afterB1[0].status).toBe('ai_match');
    expect(afterB1[1].status).toBe('fuzzy');
    expect(afterB1[2].status).toBe('no_match');

    // Second batch merges into the already-updated array — batch 1 survives.
    const afterB2 = mergeRetryResults(afterB1, new Map([[2, { index: 2, status: 'ai_match' }]]));
    expect(afterB2[0].status).toBe('ai_match');
    expect(afterB2[2].status).toBe('ai_match');
  });
});

// ---------------------------------------------------------------------------
// BUG 4 — restore parse-time notices/metadata on session resume.
// ---------------------------------------------------------------------------
describe('restoreSessionMeta', () => {
  it('restores the ct-truncated warning and cosmetic metadata', () => {
    const session = {
      importWarnings: [{ code: 'ct-truncated' }],
      detectedEncoding: 'windows-1252',
      ctTable: 'list',
      ctTextFallback: [{ location: 'Cellar', count: 3 }],
    };
    const meta = restoreSessionMeta(session);
    expect(meta.importWarnings).toEqual([{ code: 'ct-truncated' }]);
    expect(meta.detectedEncoding).toBe('windows-1252');
    expect(meta.ctTable).toBe('list');
    expect(meta.ctTextFallback).toEqual([{ location: 'Cellar', count: 3 }]);
  });

  it('falls back to safe defaults for a legacy session missing the fields', () => {
    const meta = restoreSessionMeta({});
    expect(meta.importWarnings).toEqual([]);
    expect(meta.detectedEncoding).toBeNull();
    expect(meta.ctTable).toBeNull();
    expect(meta.ctTextFallback).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG 7 — the "request pending" label must derive from the fetched status, not
// stick locally forever.
// ---------------------------------------------------------------------------
describe('nextAiBudgetRequestState', () => {
  it('releases a sticky "requested" once the server reports no pending request', () => {
    expect(nextAiBudgetRequestState('requested', { pendingRequest: false })).toBe('idle');
  });

  it('keeps "requested" while the server still reports a pending request', () => {
    expect(nextAiBudgetRequestState('requested', { pendingRequest: true })).toBe('requested');
  });

  it('leaves non-"requested" states alone', () => {
    expect(nextAiBudgetRequestState('idle', { pendingRequest: false })).toBe('idle');
    expect(nextAiBudgetRequestState('submitting', { pendingRequest: false })).toBe('submitting');
  });

  it('does not touch state when status is missing', () => {
    expect(nextAiBudgetRequestState('requested', null)).toBe('requested');
  });
});

describe('isAiBudgetRequestPending', () => {
  it('is pending when the server says so OR we optimistically requested this session', () => {
    expect(isAiBudgetRequestPending({ pendingRequest: true }, 'idle')).toBe(true);
    expect(isAiBudgetRequestPending({ pendingRequest: false }, 'requested')).toBe(true);
  });

  it('is not pending once both signals are clear', () => {
    expect(isAiBudgetRequestPending({ pendingRequest: false }, 'idle')).toBe(false);
    expect(isAiBudgetRequestPending(null, 'idle')).toBe(false);
  });
});
