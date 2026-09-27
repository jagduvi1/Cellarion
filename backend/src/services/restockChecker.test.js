/**
 * Restock alerts after a bottle is drunk (vectors in MongoDB, 2026-09).
 *
 * WHY THIS TEST EXISTS:
 * The check used to take the registry's ten closest wines and look for the
 * user's bottles among them — mostly other vintages of the drunk wine, so a
 * similar bottle the user did own could be missed and the alert fired
 * anyway. Now it compares the drunk wine with every wine still in the
 * user's cellar(s) first. Pinned: no alert while a similar wine is left
 * (scoped to the drunk bottle's cellar when the user chose that); an alert
 * with the registry's closest distinct wines otherwise; no alert when the
 * registry has nothing similar; the stored vector is reused (no embedding
 * call) and only a wine without one is embedded.
 */
jest.mock('./embedding', () => ({
  isEmbeddingConfigured: () => true,
  buildEmbeddingText: jest.fn(() => 'Name: Barolo'),
  embedSingle: jest.fn(),
}));
jest.mock('./vectorStore', () => ({ getVector: jest.fn(), search: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: () => ({ embeddingModel: 'voyage-4-large', vectorIndex: 'v1' }) }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/RestockAlert', () => ({ findOne: jest.fn(), create: jest.fn(), find: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn() }));

const embedding = require('./embedding');
const vectorStore = require('./vectorStore');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const RestockAlert = require('../models/RestockAlert');
const { createNotification } = require('./notifications');
const { checkRestockGap } = require('./restockChecker');

const WINE = { _id: 'wBarolo', name: 'Barolo', producer: 'Mascarello', type: 'red' };
const lean = (v) => ({ select: () => ({ lean: async () => v }), populate: () => ({ lean: async () => v }), lean: async () => v });
const VECTOR = Float32Array.from([0.1, 0.2, 0.3]);

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockReturnValue(lean({ username: 'u', preferences: {} }));
  Bottle.findById.mockReturnValue(lean({ _id: 'b1', vintage: '2016', wineDefinition: WINE }));
  vectorStore.getVector.mockResolvedValue(VECTOR);
  Bottle.distinct.mockResolvedValue(['wOther1', 'wOther2']);
  RestockAlert.findOne.mockResolvedValue(null);
});

test('a similar wine is still in the cellar → no alert, and the stored vector was reused', async () => {
  vectorStore.search.mockResolvedValueOnce([{ wineDefinitionId: 'wOther2', vintage: '2015', score: 0.83 }]);
  await checkRestockGap('u1', 'b1', 'c1');
  const [query, opts] = vectorStore.search.mock.calls[0];
  expect(query).toBe(VECTOR);
  expect(opts).toMatchObject({ model: 'voyage-4-large', indexVersion: 'v1', wineIds: ['wOther1', 'wOther2'], limit: 1, minScore: 0.78 });
  expect(Bottle.distinct.mock.calls[0][1]).toMatchObject({ user: 'u1', status: { $nin: expect.any(Array) } });
  expect(embedding.embedSingle).not.toHaveBeenCalled();
  expect(RestockAlert.create).not.toHaveBeenCalled();
  expect(createNotification).not.toHaveBeenCalled();
});

test('nothing similar left → an alert with the registry\'s closest distinct wines', async () => {
  vectorStore.search
    .mockResolvedValueOnce([]) // the user's own wines
    .mockResolvedValueOnce([
      { wineDefinitionId: 'wBarolo', vintage: '2015', score: 0.97 },
      { wineDefinitionId: 'wBarbaresco', vintage: '2016', score: 0.86 },
    ]);
  await checkRestockGap('u1', 'b1', 'c1');
  const registry = vectorStore.search.mock.calls[1][1];
  expect(registry).toMatchObject({ limit: 10, minScore: 0.78, distinctWines: true });
  expect(registry.wineIds).toBeUndefined();
  expect(RestockAlert.create).toHaveBeenCalledWith(expect.objectContaining({
    user: 'u1', wine: 'wBarolo', vintage: '2016', similarWineIds: ['wBarolo', 'wBarbaresco'],
  }));
  expect(createNotification).toHaveBeenCalledWith('u1', 'restock_alert', 'Restock Suggestion', expect.stringContaining('Barolo'), '/restock');
});

test('nothing in the registry is really like it → no alert', async () => {
  vectorStore.search.mockResolvedValue([]);
  await checkRestockGap('u1', 'b1', 'c1');
  expect(RestockAlert.create).not.toHaveBeenCalled();
});

test('scope "cellar": only the drunk bottle\'s cellar counts; an empty cellar skips the first search', async () => {
  User.findById.mockReturnValue(lean({ username: 'u', preferences: { restockScope: 'cellar' } }));
  Bottle.distinct.mockResolvedValue([]);
  vectorStore.search.mockResolvedValue([{ wineDefinitionId: 'wBarbaresco', vintage: '2016', score: 0.86 }]);
  await checkRestockGap('u1', 'b1', 'c1');
  expect(Bottle.distinct.mock.calls[0][1]).toMatchObject({ cellar: 'c1' });
  expect(vectorStore.search).toHaveBeenCalledTimes(1); // registry only
  expect(RestockAlert.create).toHaveBeenCalled();
});

test('a wine without a stored vector is embedded once, with the active model', async () => {
  vectorStore.getVector.mockResolvedValue(null);
  embedding.embedSingle.mockResolvedValue([0.5, 0.5, 0.5]);
  vectorStore.search.mockResolvedValueOnce([{ wineDefinitionId: 'wOther1', vintage: 'NV', score: 0.9 }]);
  await checkRestockGap('u1', 'b1', 'c1');
  expect(embedding.embedSingle).toHaveBeenCalledWith('Name: Barolo', { model: 'voyage-4-large' });
  expect(vectorStore.search.mock.calls[0][0]).toEqual([0.5, 0.5, 0.5]);
});

test('an active alert for the same wine is not duplicated', async () => {
  vectorStore.search.mockResolvedValueOnce([]).mockResolvedValueOnce([{ wineDefinitionId: 'wX', vintage: 'NV', score: 0.8 }]);
  RestockAlert.findOne.mockResolvedValue({ _id: 'existing' });
  await checkRestockGap('u1', 'b1', 'c1');
  expect(RestockAlert.create).not.toHaveBeenCalled();
});

test('checks run one at a time, however many are started at once (a bulk "mark as drunk")', async () => {
  let running = 0;
  let most = 0;
  vectorStore.getVector.mockImplementation(async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return VECTOR;
  });
  vectorStore.search.mockResolvedValue([{ wineDefinitionId: 'wOther1', vintage: 'NV', score: 0.9 }]);
  await Promise.all(Array.from({ length: 12 }, (_, i) => checkRestockGap('u1', `b${i}`, 'c1')));
  expect(vectorStore.getVector).toHaveBeenCalledTimes(12);
  expect(most).toBe(1);
});
