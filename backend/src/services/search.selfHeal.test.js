/**
 * searchBottles verifies its own hits — the fast half of the stale-index fix.
 *
 * PROD 2026-08-13: 567 of 9,918 documents in the `bottles` index named bottles
 * that no longer existed. Over MCP that read as "0 of 14"; across ~9 callers in
 * routes/cellars.js it produced phantom counts and short pages. Every delete
 * path already unindexes — the debris was operational (a restore rewound Mongo
 * while Meilisearch kept its volume; raw scripts bypassed the models), so the
 * fix belongs in the ONE function every caller goes through rather than in
 * nine call sites.
 *
 * Pinned here: stale ids are dropped from the result, queued for removal, and
 * subtracted from the reported total — and the whole thing fails OPEN, because
 * a resilience fix that can break search is not one.
 *
 * meilisearch is mocked (ESM-only, jest-hostile) exactly as the sibling
 * search.buildBottleDocument.test.js does; the index object is a stub whose
 * `search` returns whatever a test wants.
 */

const mockBottlesIndex = {
  updateSettings: jest.fn().mockResolvedValue({}),
  getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 1 }),
  search: jest.fn(),
  deleteDocuments: jest.fn().mockResolvedValue({ taskUid: 1 }),
  getDocuments: jest.fn(),
};
const mockOtherIndex = {
  updateSettings: jest.fn().mockResolvedValue({}),
  getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 1 }),
  deleteDocuments: jest.fn().mockResolvedValue({ taskUid: 2 }),
  getDocuments: jest.fn(),
};
jest.mock('meilisearch', () => ({
  Meilisearch: jest.fn(function () {
    this.health = jest.fn().mockResolvedValue({ status: 'available' });
    this.index = jest.fn((name) => (name === 'bottles' ? mockBottlesIndex : mockOtherIndex));
    this.tasks = { waitForTasks: jest.fn() };
  }),
}));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), findById: jest.fn() }));

const Bottle = require('../models/Bottle');
const searchService = require('./search');

const oid = (n) => String(n).padStart(24, '0');
const B1 = oid(1);
const B2 = oid(2);
const B3 = oid(3);

/** Bottle.find(...).select('_id').lean() → these rows. */
const primeMongo = (ids) => {
  Bottle.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(ids.map((_id) => ({ _id }))) }),
  });
};
const primeMeili = (ids, estimatedTotalHits) => {
  mockBottlesIndex.search.mockResolvedValue({
    hits: ids.map((id) => ({ id })),
    estimatedTotalHits,
    facetDistribution: { type: { red: 3 } },
    facetStats: {},
  });
};

let warnSpy;
beforeAll(async () => {
  // initialize() sets isAvailable and binds the index stubs; the background
  // sync is skipped because getStats reports a populated index.
  await searchService.initialize();
});
beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockBottlesIndex.deleteDocuments.mockResolvedValue({ taskUid: 1 });
});
afterEach(() => warnSpy.mockRestore());

describe('searchBottles drops hits Mongo no longer has', () => {
  test('the prod shape: two of three bottles are gone', async () => {
    primeMeili([B1, B2, B3], 14);
    primeMongo([B1]);

    const res = await searchService.searchBottles('barolo', { cellarId: oid(9) });

    expect(res.ids).toEqual([B1]);
    // 14 reported, 2 of this page proven dead → 12. Not "0 of 14".
    expect(res.estimatedTotalHits).toBe(12);
  });

  test('the dead ids are queued for removal from the index (self-heal)', async () => {
    primeMeili([B1, B2, B3], 14);
    primeMongo([B1]);

    await searchService.searchBottles('barolo', {});

    expect(mockBottlesIndex.deleteDocuments).toHaveBeenCalledWith([B2, B3]);
  });

  test('a clean page costs one _id-only query and no repair', async () => {
    primeMeili([B1, B2], 2);
    primeMongo([B1, B2]);

    const res = await searchService.searchBottles('', {});

    expect(res.ids).toEqual([B1, B2]);
    expect(res.estimatedTotalHits).toBe(2);
    expect(mockBottlesIndex.deleteDocuments).not.toHaveBeenCalled();
    expect(Bottle.find).toHaveBeenCalledWith({ _id: { $in: [B1, B2] } });
  });

  test('the facet-only calls (limit: 0) never touch Mongo', async () => {
    primeMeili([], 40);

    const res = await searchService.searchBottles('', { limit: 0 });

    expect(Bottle.find).not.toHaveBeenCalled();
    // Nothing was dropped, so the facet total is passed through untouched.
    expect(res.estimatedTotalHits).toBe(40);
    expect(res.facetDistribution).toEqual({ type: { red: 3 } });
  });

  test('the total never floors below zero, nor below what was returned', async () => {
    // A pathological estimate: Meilisearch says 1, the page had 3 hits, 2 dead.
    primeMeili([B1, B2, B3], 1);
    primeMongo([B1]);

    const res = await searchService.searchBottles('', {});

    expect(res.estimatedTotalHits).toBe(1);   // max(returned 1, max(0, 1-2)) = 1
    expect(res.ids).toEqual([B1]);
  });

  test('every hit dead → an empty page and a zero total, never a negative one', async () => {
    primeMeili([B1, B2], 2);
    primeMongo([]);

    const res = await searchService.searchBottles('', {});

    expect(res.ids).toEqual([]);
    expect(res.estimatedTotalHits).toBe(0);
  });

  test('FAIL-OPEN: a verification error serves the raw hits unchanged', async () => {
    primeMeili([B1, B2], 7);
    Bottle.find.mockImplementation(() => { throw new Error('CastError'); });

    const res = await searchService.searchBottles('', {});

    expect(res.ids).toEqual([B1, B2]);
    expect(res.estimatedTotalHits).toBe(7);
    expect(mockBottlesIndex.deleteDocuments).not.toHaveBeenCalled();
  });

  test('facet distribution is passed through untouched — one page cannot correct an index-wide count', async () => {
    primeMeili([B1, B2], 9);
    primeMongo([B1]);

    const res = await searchService.searchBottles('', {});

    expect(res.facetDistribution).toEqual({ type: { red: 3 } });
  });
});

describe('the reconcile surface this module exposes', () => {
  test('listIndexDocumentIds pages ids only — never whole documents', async () => {
    mockBottlesIndex.getDocuments.mockResolvedValue({
      results: [{ id: B1 }, { id: B2 }], total: 2,
    });

    const page = await searchService.listIndexDocumentIds('bottles', { limit: 500, offset: 1000 });

    expect(mockBottlesIndex.getDocuments).toHaveBeenCalledWith({ limit: 500, offset: 1000, fields: ['id'] });
    expect(page).toEqual({ ids: [B1, B2], total: 2 });
  });

  test('both reconcilable indexes resolve, and nothing else does', async () => {
    expect(searchService.RECONCILABLE_INDEXES).toEqual(['wines', 'bottles']);
    mockOtherIndex.getDocuments.mockResolvedValue({ results: [], total: 0 });
    await expect(searchService.listIndexDocumentIds('wines')).resolves.toEqual({ ids: [], total: 0 });
    await expect(searchService.listIndexDocumentIds('discussions'))
      .rejects.toThrow(/Unknown Meilisearch index/);
  });

  test('deleteIndexDocuments writes to the named index and no-ops on an empty list', async () => {
    await searchService.deleteIndexDocuments('bottles', [B1, B2]);
    expect(mockBottlesIndex.deleteDocuments).toHaveBeenCalledWith([B1, B2]);

    mockBottlesIndex.deleteDocuments.mockClear();
    await searchService.deleteIndexDocuments('bottles', []);
    expect(mockBottlesIndex.deleteDocuments).not.toHaveBeenCalled();
  });
});
