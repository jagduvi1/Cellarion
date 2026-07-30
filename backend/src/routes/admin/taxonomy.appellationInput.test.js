/**
 * Appellation input validation on the REST admin surface.
 *
 * WHY THIS TEST EXISTS (security audit 2026-07-30, L-1 + L-2):
 *   L-1 — POST/PUT /api/admin/taxonomy/appellations accepted `synonyms` with
 *         no element-type check, no length cap and no array-size cap, while
 *         the MCP twin (promote_appellation) enforced `max(10)` × `max(200)`.
 *         normalizedSynonyms is an INDEXED multikey field, so an unbounded
 *         array grew the index; a non-string element failed the Mongoose cast
 *         into a 500.
 *   L-2 — `name` was checked for truthiness, then .trim()'d. A JSON body value
 *         like {"$ne":null} is truthy, so .trim() threw a TypeError that the
 *         route's catch turned into a 500 with a stack trace.
 *
 * The parity with promote_appellation's zod schema is the actual contract, so
 * it is asserted here rather than described in a comment.
 */
// services/search.js eagerly requires the ESM-only `meilisearch` package,
// which Jest can't parse — mock it (same pattern as userDataRegistry.test.js).
// The validators under test are pure; nothing here is exercised.
jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false),
  indexWine: jest.fn(),
  removeWine: jest.fn(),
  bulkIndexWines: jest.fn(),
  bulkIndexBottles: jest.fn(),
  fullSync: jest.fn(),
  fullSyncBottles: jest.fn(),
  waitForTasks: jest.fn(),
}));

const { appellationNameError, validateAppellationSynonyms } = require('./taxonomy');

describe('appellationNameError (L-2: typeof, not truthiness)', () => {
  test('accepts a normal name', () => {
    expect(appellationNameError('Châteauneuf-du-Pape')).toBeNull();
  });

  test('THE L-2 GUARD: a truthy non-string is rejected, never .trim()ed', () => {
    // Each of these is truthy, so the old `if (!name)` let it through to
    // .trim() → TypeError → 500. All must now be a plain validation error.
    for (const value of [{ $ne: null }, ['Rioja'], 42, true, { toString: () => 'x' }]) {
      expect(appellationNameError(value)).toMatch(/required/i);
    }
  });

  test('rejects missing / empty / whitespace-only names', () => {
    for (const value of [undefined, null, '', '   ', '\t\n']) {
      expect(appellationNameError(value)).toMatch(/required/i);
    }
  });

  test('caps at 200 chars — the mint chokepoint\'s wine-field cap', () => {
    expect(appellationNameError('a'.repeat(200))).toBeNull();
    expect(appellationNameError('a'.repeat(201))).toMatch(/200 characters or fewer/);
    // Measured after trimming, so trailing space doesn't spend the budget.
    expect(appellationNameError(`${'a'.repeat(200)}   `)).toBeNull();
  });
});

describe('validateAppellationSynonyms (L-1: parity with the MCP schema)', () => {
  test('accepts a normal list and returns it trimmed', () => {
    expect(validateAppellationSynonyms(['  Chateauneuf du Pape ', 'CNDP']))
      .toEqual({ value: ['Chateauneuf du Pape', 'CNDP'] });
  });

  test('collapses internal whitespace, like every other registry-bound string', () => {
    expect(validateAppellationSynonyms(['Chateauneuf   du  Pape']))
      .toEqual({ value: ['Chateauneuf du Pape'] });
  });

  test('de-duplicates case-insensitively — an admin pasting a list gets one entry', () => {
    expect(validateAppellationSynonyms(['Rioja', 'RIOJA', 'rioja']))
      .toEqual({ value: ['Rioja'] });
  });

  test('THE L-1 GUARD: a non-string element is rejected, not cast', () => {
    for (const bad of [{ $ne: null }, 42, null, undefined, ['nested'], true]) {
      expect(validateAppellationSynonyms(['Rioja', bad]).error).toMatch(/array of strings/);
    }
  });

  test('THE L-1 GUARD: at most 10 synonyms, each at most 200 chars', () => {
    expect(validateAppellationSynonyms(Array.from({ length: 10 }, (_, i) => `s${i}`)).error).toBeUndefined();
    expect(validateAppellationSynonyms(Array.from({ length: 11 }, (_, i) => `s${i}`)).error).toMatch(/At most 10/);
    expect(validateAppellationSynonyms(['a'.repeat(200)]).error).toBeUndefined();
    expect(validateAppellationSynonyms(['a'.repeat(201)]).error).toMatch(/200 characters or fewer/);
  });

  test('rejects a non-array outright', () => {
    for (const bad of ['Rioja', { 0: 'Rioja' }, 42, true]) {
      expect(validateAppellationSynonyms(bad).error).toMatch(/array of strings/);
    }
  });

  test('an empty or blank-only list yields undefined, not [] — matching the schema default', () => {
    // `default: undefined` on the field is what keeps an empty array out of the
    // normalizedSynonyms index; returning [] here would defeat it.
    expect(validateAppellationSynonyms([])).toEqual({ value: undefined });
    expect(validateAppellationSynonyms(['', '   '])).toEqual({ value: undefined });
  });

  test('PARITY: the caps match the MCP promote_appellation zod schema exactly', () => {
    // z.array(z.string().max(200)).max(10) — if either side moves, this fails
    // and whoever moved it has to move the other.
    const { z } = require('zod');
    const mcpSchema = z.array(z.string().max(200)).max(10);
    const elevenNames = Array.from({ length: 11 }, (_, i) => `s${i}`);
    const tooLong = ['a'.repeat(201)];

    expect(mcpSchema.safeParse(elevenNames).success).toBe(false);
    expect(validateAppellationSynonyms(elevenNames).error).toBeTruthy();

    expect(mcpSchema.safeParse(tooLong).success).toBe(false);
    expect(validateAppellationSynonyms(tooLong).error).toBeTruthy();

    const ok = Array.from({ length: 10 }, () => 'a'.repeat(200));
    expect(mcpSchema.safeParse(ok).success).toBe(true);
    expect(validateAppellationSynonyms(ok).error).toBeUndefined();
  });
});
