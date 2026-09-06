/**
 * Meilisearch index MEMBERSHIP for pending-identity rows.
 *
 * indexWine is the single switch, in both directions and for both hide-flags:
 * a pending (or quarantined) wine is REMOVED from the wines index, a complete
 * one is added. That is what makes "the row (re)enters Meilisearch on
 * promotion" true without any separate add-on-promote path to forget — the
 * promoting write calls indexWine like every other write does.
 *
 * The BOTTLES index is deliberately untouched: an owner must keep finding
 * their own bottle by name even while its wine waits for a curator.
 */
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn() }));

const { Meilisearch } = require('meilisearch');
const WineDefinition = require('../models/WineDefinition');

const wineIndex = {
  updateSettings: jest.fn().mockResolvedValue({}),
  getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 5 }),
  addDocuments: jest.fn().mockResolvedValue({ taskUid: 1 }),
  deleteDocument: jest.fn().mockResolvedValue({ taskUid: 2 }),
};
const otherIndex = () => ({
  updateSettings: jest.fn().mockResolvedValue({}),
  getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 5 }),
  addDocuments: jest.fn().mockResolvedValue({ taskUid: 1 }),
  deleteDocument: jest.fn().mockResolvedValue({ taskUid: 2 }),
});

let searchService;

beforeAll(async () => {
  Meilisearch.mockImplementation(() => ({
    health: jest.fn().mockResolvedValue({}),
    index: jest.fn((name) => (name === 'wines' ? wineIndex : otherIndex())),
    tasks: { waitForTasks: jest.fn() },
  }));
  searchService = require('./search');
  await searchService.initialize();
});

const wineChain = (doc) => {
  const c = {};
  for (const m of ['populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn().mockResolvedValue(doc);
  return c;
};

beforeEach(() => {
  wineIndex.addDocuments.mockClear();
  wineIndex.deleteDocument.mockClear();
});

const WINE = {
  _id: 'wine-1',
  name: 'Kaefferkopf',
  producer: 'Cave de Kaysersberg',
  country: { _id: 'c', name: 'France' },
  region: null,
  grapes: [],
};

test('a pendingIdentity wine is REMOVED from the wines index, never added', async () => {
  WineDefinition.findById.mockReturnValue(wineChain({ ...WINE, producer: '', pendingIdentity: true }));

  await searchService.indexWine('wine-1');

  expect(wineIndex.deleteDocument).toHaveBeenCalledWith('wine-1');
  expect(wineIndex.addDocuments).not.toHaveBeenCalled();
});

test('the SAME call adds the wine once it is promoted — one switch, both directions', async () => {
  WineDefinition.findById.mockReturnValue(wineChain({ ...WINE, pendingIdentity: false }));

  await searchService.indexWine('wine-1');

  expect(wineIndex.addDocuments).toHaveBeenCalledWith(
    [expect.objectContaining({ id: 'wine-1', producer: 'Cave de Kaysersberg' })],
    { primaryKey: 'id' },
  );
  expect(wineIndex.deleteDocument).not.toHaveBeenCalled();
});

test('the quarantine flag keeps its own behaviour alongside the new one', async () => {
  WineDefinition.findById.mockReturnValue(wineChain({ ...WINE, nonWine: true }));

  await searchService.indexWine('wine-1');

  expect(wineIndex.deleteDocument).toHaveBeenCalledWith('wine-1');
});

test('the full sync excludes pending rows at the query level', async () => {
  const cursor = { [Symbol.asyncIterator]: async function* () { /* empty */ } };
  const chain = {};
  for (const m of ['populate']) chain[m] = jest.fn(() => chain);
  chain.lean = jest.fn(() => chain);
  chain.cursor = jest.fn(() => cursor);
  WineDefinition.find.mockReturnValue(chain);

  await searchService.fullSync();

  expect(WineDefinition.find).toHaveBeenCalledWith({
    nonWine: { $ne: true }, pendingIdentity: { $ne: true }, canary: { $ne: true },
  });
});
