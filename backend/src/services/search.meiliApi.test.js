/**
 * services/search against the Meilisearch client API.
 *
 * The client is constructor-mocked in every suite, so these pins are the only
 * place an API drift or a boot-time side effect shows up before prod does.
 */

jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({}));
jest.mock('../models/Discussion', () => ({}));

const { Meilisearch } = require('meilisearch');

// The admin reindex 500'd on prod (2026-08-11): meilisearch-js >=0.38 moved
// task waiting to client.tasks.waitForTasks and renamed the options.
describe('waitForTasks Meili API pin', () => {
  test('uses client.tasks.waitForTasks (0.38+ API), never client.waitForTasks', () => {
    const src = require('fs').readFileSync(require.resolve('./search'), 'utf8');
    expect(src).toMatch(/client\.tasks\.waitForTasks\(/);
    expect(src).not.toMatch(/client\.waitForTasks\(/);
  });
});

// Cellar search moved to MongoDB (services/bottleSearch, 2026-09). The old
// `bottles` index held a copy of every bottle — private notes included — so
// boot deletes it rather than leaving the copy on the Meilisearch volume.
describe('the retired bottles index', () => {
  let client;
  let index;

  // A fresh module per test: search.js keeps its client in module state.
  const boot = async () => {
    let service;
    jest.isolateModules(() => { service = require('./search'); });
    await service.initialize();
    // initialize() starts the retirement + initial syncs in the background.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    return service;
  };

  beforeEach(() => {
    index = {
      updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
      getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 5 }),
    };
    client = {
      health: jest.fn().mockResolvedValue({ status: 'available' }),
      index: jest.fn(() => index),
      getRawIndex: jest.fn(),
      deleteIndex: jest.fn().mockResolvedValue({ taskUid: 9 }),
      tasks: { waitForTasks: jest.fn() },
    };
    Meilisearch.mockImplementation(() => client);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('is deleted at boot while it still exists', async () => {
    client.getRawIndex.mockResolvedValue({ uid: 'bottles' });

    await boot();

    expect(client.getRawIndex).toHaveBeenCalledWith('bottles');
    expect(client.deleteIndex).toHaveBeenCalledWith('bottles');
  });

  test('once gone, boot leaves it alone', async () => {
    client.getRawIndex.mockRejectedValue(Object.assign(new Error('Index `bottles` not found.'), { code: 'index_not_found' }));

    await boot();

    expect(client.deleteIndex).not.toHaveBeenCalled();
  });

  test('is never configured or synced again', async () => {
    client.getRawIndex.mockRejectedValue(new Error('not found'));

    await boot();

    expect(client.index.mock.calls.map((c) => c[0])).not.toContain('bottles');
  });

  test('a failed delete is a warning — the other indexes still sync', async () => {
    client.getRawIndex.mockResolvedValue({ uid: 'bottles' });
    client.deleteIndex.mockRejectedValue(new Error('meili down'));

    const service = await boot();

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not delete the retired 'bottles' index"));
    expect(index.getStats).toHaveBeenCalled();
    expect(service.getIsAvailable()).toBe(true);
  });
});
