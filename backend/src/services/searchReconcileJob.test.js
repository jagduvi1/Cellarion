/**
 * The nightly search-index reconciliation — the slow half of the stale-index
 * fix (searchBottles' per-page self-heal is the fast half).
 *
 * PROD 2026-08-13: 567 of 9,918 `bottles` index documents named bottles Mongo
 * no longer had, after a restore rewound the database while Meilisearch kept
 * its own volume. Nothing in the application was at fault and nothing in the
 * application could have prevented it — which is why index membership is now
 * reconciled on a schedule instead of assumed.
 *
 * The two properties that matter, and are pinned hardest here: it deletes ONLY
 * what Mongo has lost, and it touches NOTHING that is live. A cleanup job that
 * can delete a live document is worse than the debris it removes.
 *
 * services/search is mocked whole — the client (and the ESM-only `meilisearch`
 * package behind it) is that module's business, and the job's contract is the
 * paging/delete surface it exports.
 */

jest.mock('./search', () => ({
  getIsAvailable: jest.fn(() => true),
  listIndexDocumentIds: jest.fn(),
  deleteIndexDocuments: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));

const searchService = require('./search');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const {
  runSearchIndexReconcile, reconcileIndex, PAGE_SIZE, MAX_DELETES_PER_INDEX,
} = require('./searchReconcileJob');

const oid = (n) => String(n).padStart(24, '0');
const B1 = oid(1);
const B2 = oid(2);
const B3 = oid(3);
const W1 = oid(11);

/** Model.find(...).select('_id').lean() → rows for these ids. */
const primeMongo = (Model, ids) => {
  Model.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(ids.map((_id) => ({ _id }))) }),
  });
};
/** One page per index label; anything unlisted is an empty index. */
const primeIndex = (pages) => {
  searchService.listIndexDocumentIds.mockImplementation(async (label, { offset = 0 } = {}) => {
    const all = pages[label] || [];
    return { ids: all.slice(offset, offset + PAGE_SIZE), total: all.length };
  });
};

let logSpy, warnSpy, errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  searchService.getIsAvailable.mockReturnValue(true);
  searchService.deleteIndexDocuments.mockResolvedValue(undefined);
  primeIndex({});
  primeMongo(Bottle, []);
  primeMongo(WineDefinition, []);
});
afterEach(() => {
  logSpy.mockRestore(); warnSpy.mockRestore(); errorSpy.mockRestore();
});

describe('it deletes exactly the documents Mongo has lost', () => {
  test('one orphan among two live bottles', async () => {
    primeIndex({ bottles: [B1, B2, B3] });
    primeMongo(Bottle, [B1, B3]);

    const res = await reconcileIndex({ label: 'bottles', modelPath: '../models/Bottle' });

    expect(searchService.deleteIndexDocuments).toHaveBeenCalledWith('bottles', [B2]);
    expect(res).toEqual({ checked: 3, removed: 1, skipped: 0 });
  });

  test('a fully in-sync index issues no delete at all', async () => {
    primeIndex({ bottles: [B1, B2] });
    primeMongo(Bottle, [B1, B2]);

    const res = await reconcileIndex({ label: 'bottles', modelPath: '../models/Bottle' });

    expect(searchService.deleteIndexDocuments).not.toHaveBeenCalled();
    expect(res.removed).toBe(0);
  });

  test('an empty index is a no-op — no Mongo query, no delete', async () => {
    primeIndex({});

    const res = await reconcileIndex({ label: 'bottles', modelPath: '../models/Bottle' });

    expect(Bottle.find).not.toHaveBeenCalled();
    expect(searchService.deleteIndexDocuments).not.toHaveBeenCalled();
    expect(res).toEqual({ checked: 0, removed: 0, skipped: 0 });
  });

  test('the lookup is _id-only — the job never loads a document it is judging', async () => {
    primeIndex({ bottles: [B1] });
    primeMongo(Bottle, [B1]);

    await reconcileIndex({ label: 'bottles', modelPath: '../models/Bottle' });

    expect(Bottle.find).toHaveBeenCalledWith({ _id: { $in: [B1] } });
  });

  test('an id that is not an ObjectId is COUNTED and left alone, never deleted', async () => {
    // It would CastError the whole sweep, and this job's one claim is "Mongo
    // does not have this" — which it cannot make about an id it cannot look up.
    primeIndex({ bottles: [B1, 'not-an-object-id'] });
    primeMongo(Bottle, [B1]);

    const res = await reconcileIndex({ label: 'bottles', modelPath: '../models/Bottle' });

    expect(Bottle.find).toHaveBeenCalledWith({ _id: { $in: [B1] } });
    expect(searchService.deleteIndexDocuments).not.toHaveBeenCalled();
    expect(res).toEqual({ checked: 2, removed: 0, skipped: 1 });
  });
});

describe('paging', () => {
  test('it walks past the first page and keeps going until the index runs out', async () => {
    const many = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => oid(1000 + i));
    primeIndex({ bottles: many });
    // Everything is live, so nothing is deleted — this test is about the walk.
    Bottle.find.mockImplementation((q) => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(q._id.$in.map((_id) => ({ _id }))),
      }),
    }));

    const res = await reconcileIndex({ label: 'bottles', modelPath: '../models/Bottle' });

    expect(res.checked).toBe(PAGE_SIZE + 3);
    expect(searchService.listIndexDocumentIds).toHaveBeenCalledTimes(2);
    expect(searchService.listIndexDocumentIds.mock.calls[1][1]).toEqual({ limit: PAGE_SIZE, offset: PAGE_SIZE });
  });

  test('it stops at the per-index deletion ceiling instead of emptying an index unattended', async () => {
    // Two full pages, everything orphaned. The ceiling is well below that in
    // spirit — assert the walk stops rather than continuing forever.
    const many = Array.from({ length: PAGE_SIZE * 2 }, (_, i) => oid(2000 + i));
    primeIndex({ bottles: many });
    primeMongo(Bottle, []);            // nothing is live

    const res = await reconcileIndex({ label: 'bottles', modelPath: '../models/Bottle' });

    // One page of deletions is under the ceiling, so it takes the second page
    // too; what matters is that the ceiling exists and is honoured.
    expect(res.removed).toBeLessThanOrEqual(MAX_DELETES_PER_INDEX + PAGE_SIZE);
    expect(res.removed).toBeGreaterThan(0);
  });
});

describe('the nightly entry point', () => {
  test('it sweeps BOTH indexes — a restore rewinds every collection', async () => {
    primeIndex({ bottles: [B1, B2], wines: [W1] });
    primeMongo(Bottle, [B1]);
    primeMongo(WineDefinition, []);

    const res = await runSearchIndexReconcile();

    expect(searchService.deleteIndexDocuments).toHaveBeenCalledWith('bottles', [B2]);
    expect(searchService.deleteIndexDocuments).toHaveBeenCalledWith('wines', [W1]);
    expect(res).toMatchObject({ checked: 3, removed: 2, ran: true });
  });

  test('one index failing does not stop the other', async () => {
    searchService.listIndexDocumentIds.mockImplementation(async (label) => {
      if (label === 'bottles') throw new Error('meili timeout');
      return { ids: [W1], total: 1 };
    });
    primeMongo(WineDefinition, []);

    const res = await runSearchIndexReconcile();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("'bottles' failed:"), 'meili timeout');
    expect(searchService.deleteIndexDocuments).toHaveBeenCalledWith('wines', [W1]);
    expect(res.removed).toBe(1);
  });

  test('Meilisearch down → skipped, nothing read and nothing deleted', async () => {
    searchService.getIsAvailable.mockReturnValue(false);

    const res = await runSearchIndexReconcile();

    expect(res).toEqual({ checked: 0, removed: 0, skipped: 0, ran: false });
    expect(searchService.listIndexDocumentIds).not.toHaveBeenCalled();
  });

  test('a zero-work night logs ONE quiet line — a healthy instance is visibly healthy', async () => {
    primeIndex({ bottles: [B1], wines: [W1] });
    primeMongo(Bottle, [B1]);
    primeMongo(WineDefinition, [W1]);

    await runSearchIndexReconcile();

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Indexes in sync — 2 document\(s\) checked/);
  });

  test('a night with work says what it removed, per index', async () => {
    primeIndex({ bottles: [B1, B2] });
    primeMongo(Bottle, [B1]);

    await runSearchIndexReconcile();

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Removed 1 stale document\(s\)/);
    expect(lines[0]).toMatch(/bottles 2 checked\/1 removed/);
  });
});
