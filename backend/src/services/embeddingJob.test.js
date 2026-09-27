/**
 * The embedding job writes each wine's vector onto its WineEmbedding row
 * (2026-09: Qdrant retired — services/vectorStore searches the rows).
 *
 * WHY THIS TEST EXISTS:
 * Pinned: a fresh vector is stored encoded (int8 + norm + dim) with an
 * upsert; a row is skipped only when its text, status AND dimension are
 * current (a row without a vector — not yet migrated — is stale); a failed
 * embed marks the row but leaves any vector it had searchable; a FULL run
 * re-embeds in place and only afterwards deletes the rows it did not write
 * (the old drop-everything-first left chat empty until the rebuild ended).
 */
jest.mock('../config/aiConfig', () => ({
  get: () => ({ embeddingModel: 'voyage-4-large', vectorIndex: 'v1', embeddingBatchDelayMs: 0, chatEnabled: true }),
}));
jest.mock('./embedding', () => ({
  embedSingle: jest.fn(),
  buildEmbeddingText: jest.fn((wine, vintage) => `Name: ${wine.name}\nVintage: ${vintage}`),
  isEmbeddingConfigured: () => true,
  getEmbeddingDimension: () => 8,
}));
jest.mock('../models/WineEmbedding', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));

const crypto = require('crypto');
const { embedSingle } = require('./embedding');
const WineEmbedding = require('../models/WineEmbedding');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const embeddingJob = require('./embeddingJob');

const hash = (name, vintage) => crypto.createHash('sha256').update(`Name: ${name}\nVintage: ${vintage}`).digest('hex');
const VEC = [0.5, -0.25, 0.1, 0, 0.3, -0.4, 0.2, 0.05];
const wineChain = (wine) => { const c = { populate: () => c, lean: async () => wine }; return c; };
const rowChain = (row) => ({ select: () => ({ lean: async () => row }) });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  embedSingle.mockResolvedValue(VEC);
  WineEmbedding.findOneAndUpdate.mockResolvedValue({});
  WineEmbedding.deleteMany.mockResolvedValue({ deletedCount: 3 });
  WineDefinition.findById.mockImplementation((id) => wineChain({ _id: id, name: `Wine ${id}` }));
  WineEmbedding.findOne.mockReturnValue(rowChain(null));
});

async function runToEnd(mode) {
  await embeddingJob.start({ mode });
  for (let i = 0; i < 200 && ['running', 'stopping'].includes(embeddingJob.getStatus().status); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return embeddingJob.getStatus();
}

describe('embedSinglePair', () => {
  test('stores the encoded vector on the row (upsert)', async () => {
    await embeddingJob.embedSinglePair('w1', '2015');
    expect(embedSingle).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = WineEmbedding.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ wineDefinition: 'w1', vintage: '2015', model: 'voyage-4-large', indexVersion: 'v1' });
    expect(opts).toEqual({ upsert: true });
    const set = update.$set;
    expect(Buffer.isBuffer(set.vector)).toBe(true);
    expect(set.vector.length).toBe(8);
    expect(set).toMatchObject({ dim: 8, status: 'ok', errorMessage: null, textHash: hash('Wine w1', '2015') });
    expect(set.norm).toBeGreaterThan(0);
  });

  test('skips a current row — and re-embeds one without a vector or of another dimension', async () => {
    WineEmbedding.findOne.mockReturnValue(rowChain({ textHash: hash('Wine w1', '2015'), status: 'ok', dim: 8 }));
    await embeddingJob.embedSinglePair('w1', '2015');
    expect(embedSingle).not.toHaveBeenCalled();

    WineEmbedding.findOne.mockReturnValue(rowChain({ textHash: hash('Wine w1', '2015'), status: 'ok' })); // not migrated
    await embeddingJob.embedSinglePair('w1', '2015');
    WineEmbedding.findOne.mockReturnValue(rowChain({ textHash: hash('Wine w1', '2015'), status: 'ok', dim: 1024 })); // other model size
    await embeddingJob.embedSinglePair('w1', '2015');
    expect(embedSingle).toHaveBeenCalledTimes(2);
  });

  test('never embeds a pending-identity or canary wine', async () => {
    WineDefinition.findById.mockReturnValueOnce(wineChain({ _id: 'w2', name: 'x', pendingIdentity: true }));
    await embeddingJob.embedSinglePair('w2', 'NV');
    WineDefinition.findById.mockReturnValueOnce(wineChain({ _id: 'w3', name: 'y', canary: true }));
    await embeddingJob.embedSinglePair('w3', 'NV');
    expect(embedSingle).not.toHaveBeenCalled();
  });
});

describe('the batch job', () => {
  beforeEach(() => {
    Bottle.aggregate.mockResolvedValue([
      { wineDefinition: 'w1', vintage: '2015' },
      { wineDefinition: 'w2', vintage: 'NV' },
    ]);
  });

  test('incremental: skips current rows, embeds stale ones, deletes nothing', async () => {
    WineEmbedding.findOne.mockImplementation((q) => rowChain(q.wineDefinition === 'w1'
      ? { textHash: hash('Wine w1', '2015'), status: 'ok', dim: 8 }
      : null));
    const status = await runToEnd('incremental');
    expect(status).toMatchObject({ status: 'done', total: 2, done: 2, skipped: 1, errors: 0 });
    expect(embedSingle).toHaveBeenCalledTimes(1);
    expect(WineEmbedding.deleteMany).not.toHaveBeenCalled();
  });

  test('full: re-embeds every pair in place, THEN removes the rows it did not write', async () => {
    WineEmbedding.findOne.mockReturnValue(rowChain({ textHash: hash('Wine w1', '2015'), status: 'ok', dim: 8 }));
    // The rows the run did not rewrite (older than its start):
    WineEmbedding.find.mockReturnValue({ select: () => ({ lean: async () => [
      { _id: 'oldModel', wineDefinition: 'w1', vintage: '2015', model: 'voyage-4-lite' }, // a previous model
      { _id: 'gone', wineDefinition: 'w9', vintage: '2001', model: 'voyage-4-large' },    // no longer in any cellar
      { _id: 'lateAdd', wineDefinition: 'w3', vintage: '2019', model: 'voyage-4-large' }, // became active mid-run
      { _id: 'pending', wineDefinition: 'wP', vintage: 'NV', model: 'voyage-4-large' },   // a wine never embedded
    ] }) });
    // The snapshot at the start, then the pairs active when the run ends.
    Bottle.aggregate
      .mockResolvedValueOnce([
        { wineDefinition: 'w1', vintage: '2015' },
        { wineDefinition: 'w2', vintage: 'NV' },
        { wineDefinition: 'wP', vintage: 'NV' },
      ])
      .mockResolvedValueOnce([
        { wineDefinition: 'w1', vintage: '2015' },
        { wineDefinition: 'w2', vintage: 'NV' },
        { wineDefinition: 'w3', vintage: '2019' },
        { wineDefinition: 'wP', vintage: 'NV' },
      ]);
    WineDefinition.findById.mockImplementation((id) => wineChain(id === 'wP' ? { _id: id, name: 'p', pendingIdentity: true } : { _id: id, name: `Wine ${id}` }));

    const status = await runToEnd('full');
    expect(status).toMatchObject({ status: 'done', done: 3, skipped: 1 });
    expect(embedSingle).toHaveBeenCalledTimes(2);
    expect(WineEmbedding.find.mock.calls[0][0]).toMatchObject({ indexVersion: 'v1', embeddedAt: { $lt: expect.any(Date) } });
    const deleted = WineEmbedding.deleteMany.mock.calls.flatMap(([f]) => f._id.$in);
    expect(deleted.sort()).toEqual(['gone', 'oldModel', 'pending']);
    // Nothing was deleted before the rows were rewritten.
    const lastWrite = Math.max(...WineEmbedding.findOneAndUpdate.mock.invocationCallOrder);
    expect(WineEmbedding.deleteMany.mock.invocationCallOrder[0]).toBeGreaterThan(lastWrite);
  });

  test('a failed embed marks the row but never touches the vector it has', async () => {
    embedSingle.mockRejectedValueOnce(new Error('voyage down'));
    const status = await runToEnd('incremental');
    expect(status.errors).toBe(1);
    const errorWrite = WineEmbedding.findOneAndUpdate.mock.calls.find(([, u]) => u.$set && u.$set.status === 'error');
    expect(errorWrite[1].$set).toEqual(expect.objectContaining({ status: 'error', textHash: '', errorMessage: 'voyage down' }));
    expect(errorWrite[1].$set.vector).toBeUndefined();
    expect(errorWrite[1].$set.dim).toBeUndefined();
  });
});
