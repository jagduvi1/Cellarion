/**
 * applyBulkWriteError — partial-success recovery for the LWIN import flush
 * (audit 2026-08-03 H1).
 *
 * An UNORDERED bulkWrite commits every non-failing op even when the promise
 * rejects (e.g. two CSV rows normalizing to the same unique normalizedKey —
 * common in LWIN dumps). The old flush let the rejection bubble into the
 * per-row catch, which misattributed a whole-batch failure to ONE row: up to
 * 499 genuinely-created wines vanished from the stats and never reached
 * finalizeMintedWines (no canonicalKey/slug/createdVia). This pins: failing
 * ops are charged to their own CSV rows, the partial result is returned for
 * crediting, and a hard (non-bulk) failure reports the whole batch instead of
 * discarding the accumulated stats.
 */

jest.mock('../../services/search', () => ({ fullSync: jest.fn(), indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), findOne: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../../models/Country', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Region', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Appellation', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));

const { applyBulkWriteError } = require('./import');

const freshStats = () => ({
  total: 10, created: 0, updated: 0, skipped: 0,
  skippedReasons: { delisted: 0, notWine: 0, missingFields: 0, other: 0 },
  errors: [],
});

// Batch rows in op order, each remembering its CSV row number.
const rows = (...rowIndexes) => rowIndexes.map((rowIndex) => ({ rowIndex }));

const bulkError = ({ writeErrors, result }) =>
  Object.assign(new Error('E11000 duplicate key'), {
    name: 'MongoBulkWriteError',
    writeErrors,
    result,
  });

describe('applyBulkWriteError — MongoBulkWriteError (partial success)', () => {
  test('failing ops are charged to their own CSV rows; the partial result is returned', () => {
    const stats = freshStats();
    const err = bulkError({
      // Op #1 (CSV row 42) collided on normalizedKey; ops #0 and #2 landed.
      writeErrors: [{ index: 1, errmsg: 'E11000 duplicate key error (normalizedKey)' }],
      result: { upsertedCount: 2, modifiedCount: 0, upsertedIds: { 0: 'idA', 2: 'idC' } },
    });

    const result = applyBulkWriteError(err, rows(41, 42, 43), stats);

    expect(result).toBe(err.result); // caller credits created/updated/mintedIds from this
    expect(stats.total).toBe(9);     // only the ONE failing row is deducted
    expect(stats.skipped).toBe(1);
    expect(stats.skippedReasons.other).toBe(1);
    expect(stats.errors).toEqual([{ row: 42, reason: 'E11000 duplicate key error (normalizedKey)' }]);
  });

  test('multiple write errors each map to their own row', () => {
    const stats = freshStats();
    const err = bulkError({
      writeErrors: [
        { index: 0, errmsg: 'dup A' },
        { index: 2, errmsg: 'dup C' },
      ],
      result: { upsertedCount: 1, modifiedCount: 0, upsertedIds: { 1: 'idB' } },
    });

    applyBulkWriteError(err, rows(7, 8, 9), stats);

    expect(stats.total).toBe(8);
    expect(stats.skipped).toBe(2);
    expect(stats.errors).toEqual([
      { row: 7, reason: 'dup A' },
      { row: 9, reason: 'dup C' },
    ]);
  });

  test('a single (non-array) writeError is normalized', () => {
    const stats = freshStats();
    const err = bulkError({
      writeErrors: { index: 0, errmsg: 'dup' },
      result: { upsertedCount: 0, modifiedCount: 0, upsertedIds: {} },
    });

    const result = applyBulkWriteError(err, rows(3), stats);
    expect(result).toBe(err.result);
    expect(stats.errors).toEqual([{ row: 3, reason: 'dup' }]);
  });

  test('the error cap (100) is respected', () => {
    const stats = freshStats();
    stats.errors = Array.from({ length: 100 }, (_, i) => ({ row: i, reason: 'x' }));
    const err = bulkError({
      writeErrors: [{ index: 0, errmsg: 'dup' }],
      result: { upsertedCount: 0, modifiedCount: 0, upsertedIds: {} },
    });

    applyBulkWriteError(err, rows(1), stats);
    expect(stats.errors).toHaveLength(100); // still counted...
    expect(stats.skipped).toBe(1);          // ...just not listed
  });
});

describe('applyBulkWriteError — hard (non-bulk) failure', () => {
  test('the whole batch becomes row errors and null is returned (stats survive, no crediting)', () => {
    const stats = freshStats();
    const err = new Error('connection reset');

    const result = applyBulkWriteError(err, rows(1, 2, 3), stats);

    expect(result).toBeNull();
    expect(stats.total).toBe(7);
    expect(stats.skipped).toBe(3);
    expect(stats.errors).toEqual([
      { row: 1, reason: 'Batch write failed: connection reset' },
      { row: 2, reason: 'Batch write failed: connection reset' },
      { row: 3, reason: 'Batch write failed: connection reset' },
    ]);
  });

  test('a MongoBulkWriteError WITHOUT a result is treated as a hard failure (nothing to credit)', () => {
    const stats = freshStats();
    const err = Object.assign(new Error('boom'), { name: 'MongoBulkWriteError' });

    const result = applyBulkWriteError(err, rows(5), stats);
    expect(result).toBeNull();
    expect(stats.errors[0].row).toBe(5);
  });
});
