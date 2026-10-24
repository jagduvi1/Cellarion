/**
 * initialize({ sync: false }): connect without the boot-time background work.
 *
 * A standalone script (scripts/lib/scriptSearch) needs the client and the
 * index handles, nothing more. The background block — dropping retired
 * indexes and the initial full sync of an EMPTY index — belongs to the
 * server: a script that disconnects from MongoDB halfway through that sync
 * leaves a partial index, which the next boot finds non-empty and never
 * completes.
 */

jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn() }));

const { Meilisearch } = require('meilisearch');

let client;
let index;

// A fresh module per test: search.js keeps its client in module state.
const load = () => {
  let service;
  jest.isolateModules(() => { service = require('./search'); });
  return service;
};
// initialize() starts its background work without awaiting it.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  index = {
    updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
    // An empty index: exactly the case where boot would start a full sync.
    getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 0 }),
    addDocuments: jest.fn().mockResolvedValue({ taskUid: 2 }),
  };
  client = {
    health: jest.fn().mockResolvedValue({ status: 'available' }),
    index: jest.fn(() => index),
    getRawIndex: jest.fn().mockRejectedValue({ code: 'index_not_found' }),
    deleteIndex: jest.fn(),
    tasks: { waitForTasks: jest.fn() },
  };
  Meilisearch.mockImplementation(() => client);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('sync: false connects and configures the indexes, and starts no background work', async () => {
  const service = load();
  await service.initialize({ sync: false });
  await settle();

  expect(service.getIsAvailable()).toBe(true);
  expect(index.updateSettings).toHaveBeenCalled();
  expect(index.getStats).not.toHaveBeenCalled();
  expect(index.addDocuments).not.toHaveBeenCalled();
  expect(client.getRawIndex).not.toHaveBeenCalled();
  expect(client.deleteIndex).not.toHaveBeenCalled();
});

test('the default (server boot) still checks for an empty index in the background', async () => {
  // Populated, so the check finds nothing to sync.
  index.getStats.mockResolvedValue({ numberOfDocuments: 5 });
  const service = load();
  await service.initialize();
  await settle();

  expect(service.getIsAvailable()).toBe(true);
  expect(client.getRawIndex).toHaveBeenCalledWith('bottles');
  expect(index.getStats).toHaveBeenCalled();
});

test('sync: false still reports Meilisearch as unavailable when it cannot connect', async () => {
  client.health.mockRejectedValue(new Error('connect ECONNREFUSED'));
  const service = load();
  await service.initialize({ sync: false });

  expect(service.getIsAvailable()).toBe(false);
});
