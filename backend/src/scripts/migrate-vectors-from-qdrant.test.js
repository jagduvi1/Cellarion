/**
 * One-off migration: the vectors in the retired Qdrant container are copied
 * onto their WineEmbedding rows, so nothing has to be re-embedded.
 *
 * WHY THIS TEST EXISTS:
 * Production runs it once, right after the upgrade, while the old container
 * still runs. Pinned: a dry run writes nothing; --apply writes each point's
 * encoded vector onto the row whose qdrantPointId matches, and only if that
 * row has no vector yet (a row the new version already re-embedded keeps its
 * fresher one); leftover points without a row are skipped; every wines_*
 * collection is read, page by page.
 */
process.env.QDRANT_URL = 'http://qdrant.test:6333';

jest.mock('../models/WineEmbedding', () => ({
  find: jest.fn(),
  bulkWrite: jest.fn(),
  countDocuments: jest.fn(),
}));

const WineEmbedding = require('../models/WineEmbedding');
const { migrate } = require('./migrate-vectors-from-qdrant');

const vec = (x) => Array.from({ length: 8 }, (_, i) => (i === 0 ? x : 0.1));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  WineEmbedding.find.mockReturnValue({ select: () => ({ lean: async () => [
    { _id: 'r1', qdrantPointId: 'p1' },            // no vector yet → copied
    { _id: 'r2', qdrantPointId: 'p2', dim: 8 },    // re-embedded already → kept
    { _id: 'r3', qdrantPointId: 'p3' },            // in the second page
  ] }) });
  WineEmbedding.countDocuments.mockResolvedValue(0);
  const pages = {
    wines_v1: [
      { points: [{ id: 'p1', vector: vec(1) }, { id: 'p2', vector: vec(2) }, { id: 'orphan', vector: vec(3) }], next_page_offset: 'next' },
      { points: [{ id: 'p3', vector: vec(4) }], next_page_offset: null },
    ],
  };
  global.fetch = jest.fn(async (url, opts) => {
    const path = url.replace('http://qdrant.test:6333', '');
    let result;
    if (path === '/collections') result = { collections: [{ name: 'wines_v1' }, { name: 'something_else' }] };
    else if (path === '/collections/wines_v1/points/scroll') {
      const body = JSON.parse(opts.body);
      expect(body).toMatchObject({ with_vector: true, with_payload: false });
      result = body.offset === 'next' ? pages.wines_v1[1] : pages.wines_v1[0];
    } else throw new Error(`unexpected ${path}`);
    return { ok: true, json: async () => ({ result }) };
  });
});

test('dry run: counts what it would copy, writes nothing', async () => {
  const counts = await migrate({ apply: false });
  expect(counts).toMatchObject({ points: 4, copied: 2, alreadyHadVector: 1, noRow: 1 });
  expect(WineEmbedding.bulkWrite).not.toHaveBeenCalled();
});

test('--apply writes the encoded vector onto the matching rows that have none', async () => {
  const counts = await migrate({ apply: true });
  expect(counts).toMatchObject({ points: 4, copied: 2, alreadyHadVector: 1, noRow: 1 });
  const ops = WineEmbedding.bulkWrite.mock.calls.flatMap(([batch]) => batch);
  expect(ops.map((o) => o.updateOne.filter._id)).toEqual(['r1', 'r3']);
  const first = ops[0].updateOne;
  // Only a row still without a vector is written — a concurrent re-embed wins.
  expect(first.filter).toEqual({ _id: 'r1', dim: { $exists: false } });
  expect(first.update.$set.dim).toBe(8);
  expect(first.update.$set.norm).toBeGreaterThan(0);
  expect(Buffer.isBuffer(first.update.$set.vector)).toBe(true);
  expect(first.update.$set.vector.length).toBe(8);
  // The point id stays on the row (a rollback to the Qdrant version still works).
  expect(first.update.$unset).toBeUndefined();
});

test('refuses to run without QDRANT_URL, naming how to pass it', async () => {
  jest.resetModules();
  const saved = process.env.QDRANT_URL;
  delete process.env.QDRANT_URL;
  const fresh = require('./migrate-vectors-from-qdrant');
  await expect(fresh.migrate({ apply: false })).rejects.toThrow(/QDRANT_URL is not set/);
  process.env.QDRANT_URL = saved;
});
