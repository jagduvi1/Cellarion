const { parsePagination } = require('./pagination');

describe('parsePagination', () => {
  // ─── Default values ──────────────────────────────────────────────────────

  test('returns default values when no query params provided', () => {
    const result = parsePagination({});
    expect(result).toEqual({ limit: 50, offset: 0, page: 1 });
  });

  test('returns default values for empty query', () => {
    const result = parsePagination({});
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
    expect(result.page).toBe(1);
  });

  // ─── Custom limit ────────────────────────────────────────────────────────

  test('custom limit is respected', () => {
    const result = parsePagination({ limit: '25' });
    expect(result.limit).toBe(25);
  });

  test('limit is clamped to maxLimit (default 200)', () => {
    const result = parsePagination({ limit: '500' });
    expect(result.limit).toBe(200);
  });

  test('limit is clamped to custom maxLimit', () => {
    const result = parsePagination({ limit: '150' }, { maxLimit: 100 });
    expect(result.limit).toBe(100);
  });

  test('limit of 0 is falsy so falls back to default, then clamped', () => {
    // parseInt('0') is 0, which is falsy → falls back to defaultLimit (50)
    const result = parsePagination({ limit: '0' });
    expect(result.limit).toBe(50);
  });

  test('limit of 1 is the effective minimum', () => {
    const result = parsePagination({ limit: '1' });
    expect(result.limit).toBe(1);
  });

  test('negative limit is falsy after parseInt, falls back to default', () => {
    // parseInt('-10') = -10, which is truthy, Math.max(-10, 1) = 1
    const result = parsePagination({ limit: '-10' });
    expect(result.limit).toBe(1);
  });

  // ─── Page-based addressing ───────────────────────────────────────────────

  test('page-based addressing computes offset correctly', () => {
    const result = parsePagination({ page: '3', limit: '20' });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(40); // (3-1) * 20
  });

  test('page=1 gives offset=0', () => {
    const result = parsePagination({ page: '1', limit: '50' });
    expect(result.offset).toBe(0);
    expect(result.page).toBe(1);
  });

  test('page minimum is 1', () => {
    const result = parsePagination({ page: '0' });
    expect(result.page).toBe(1);
    expect(result.offset).toBe(0);
  });

  test('negative page becomes 1', () => {
    const result = parsePagination({ page: '-5' });
    expect(result.page).toBe(1);
    expect(result.offset).toBe(0);
  });

  // ─── Offset-based addressing ─────────────────────────────────────────────

  test('offset-based addressing when no page is provided', () => {
    const result = parsePagination({ offset: '100', limit: '50' });
    expect(result.offset).toBe(100);
    expect(result.limit).toBe(50);
    expect(result.page).toBe(3); // floor(100/50) + 1
  });

  test('offset=0 gives page=1', () => {
    const result = parsePagination({ offset: '0', limit: '25' });
    expect(result.offset).toBe(0);
    expect(result.page).toBe(1);
  });

  test('negative offset becomes 0', () => {
    const result = parsePagination({ offset: '-20' });
    expect(result.offset).toBe(0);
    expect(result.page).toBe(1);
  });

  // ─── Page takes precedence over offset ───────────────────────────────────

  test('page takes precedence over offset when both are provided', () => {
    const result = parsePagination({ page: '2', offset: '999', limit: '10' });
    // page is checked first (query.page != null)
    expect(result.page).toBe(2);
    expect(result.offset).toBe(10); // (2-1) * 10, NOT 999
  });

  // ─── Custom defaults ────────────────────────────────────────────────────

  test('custom default limit is used when no limit in query', () => {
    const result = parsePagination({}, { limit: 25 });
    expect(result.limit).toBe(25);
  });

  test('custom maxLimit clamps the limit', () => {
    const result = parsePagination({ limit: '100' }, { limit: 25, maxLimit: 50 });
    expect(result.limit).toBe(50);
  });

  // ─── NaN values fall back to defaults ────────────────────────────────────

  test('NaN limit falls back to default', () => {
    const result = parsePagination({ limit: 'abc' });
    expect(result.limit).toBe(50);
  });

  test('NaN page falls back to 1', () => {
    const result = parsePagination({ page: 'xyz' });
    expect(result.page).toBe(1);
    expect(result.offset).toBe(0);
  });

  test('NaN offset falls back to 0', () => {
    const result = parsePagination({ offset: 'bad' });
    expect(result.offset).toBe(0);
    expect(result.page).toBe(1);
  });

  test('NaN limit with custom default falls back to custom default', () => {
    const result = parsePagination({ limit: 'nope' }, { limit: 30 });
    expect(result.limit).toBe(30);
  });

  // ─── Skip alias for offset ──────────────────────────────────────────────

  test('skip is treated as an alias for offset', () => {
    const result = parsePagination({ skip: '60', limit: '20' });
    expect(result.offset).toBe(60);
    expect(result.page).toBe(4); // floor(60/20) + 1
  });

  test('offset takes precedence over skip when both are provided', () => {
    const result = parsePagination({ offset: '40', skip: '100', limit: '20' });
    expect(result.offset).toBe(40); // offset wins
  });

  test('page takes precedence over skip', () => {
    const result = parsePagination({ page: '2', skip: '999', limit: '10' });
    expect(result.page).toBe(2);
    expect(result.offset).toBe(10); // (2-1) * 10, NOT 999
  });

  test('negative skip becomes 0', () => {
    const result = parsePagination({ skip: '-10' });
    expect(result.offset).toBe(0);
    expect(result.page).toBe(1);
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────

  test('offset not a perfect multiple of limit derives correct page', () => {
    const result = parsePagination({ offset: '75', limit: '50' });
    expect(result.offset).toBe(75);
    expect(result.page).toBe(2); // floor(75/50) + 1
  });

  test('very large page number works correctly', () => {
    const result = parsePagination({ page: '10000', limit: '50' });
    expect(result.page).toBe(10000);
    expect(result.offset).toBe(499950);
  });
});
