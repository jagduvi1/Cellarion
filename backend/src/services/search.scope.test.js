/**
 * searchBottles must NEVER run unscoped.
 *
 * Security audit 2026-09-02 (D10-5): with an EMPTY cellar list — a user who
 * owns no cellar, which is every freshly registered account since registration
 * creates none — the scope branches pushed no filter at all, so the Meilisearch
 * query ran across every tenant's bottles and MCP search_bottles hydrated
 * whatever came back. The match-nothing fallback only covered "ids given but
 * all stripped". These tests pin the contract: no usable scope ⇒ a filter that
 * matches nothing. There is no legitimate unscoped caller.
 */
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn() }));

const { Meilisearch } = require('meilisearch');

// One shared index mock for every index name: the tests only care about the
// options searchBottles hands to `search`, and no other index is queried here.
const index = {
  updateSettings: jest.fn().mockResolvedValue({}),
  getStats: jest.fn().mockResolvedValue({ numberOfDocuments: 5 }),
  addDocuments: jest.fn().mockResolvedValue({ taskUid: 1 }),
  deleteDocument: jest.fn().mockResolvedValue({ taskUid: 2 }),
  search: jest.fn().mockResolvedValue({ hits: [], estimatedTotalHits: 0 }),
};

let searchService;

beforeAll(async () => {
  Meilisearch.mockImplementation(() => ({
    health: jest.fn().mockResolvedValue({}),
    index: jest.fn(() => index),
    tasks: { waitForTasks: jest.fn() },
  }));
  searchService = require('./search');
  await searchService.initialize();
});

beforeEach(() => index.search.mockClear());

const lastFilter = () => index.search.mock.calls.at(-1)[1].filter;
const MATCH_NOTHING = 'cellarId = ""';

describe('searchBottles scope (audit 2026-09-02 D10-5)', () => {
  test('an EMPTY cellarIds array — a user with no owned cellar — matches nothing', async () => {
    await searchService.searchBottles('wine', { cellarIds: [] });
    expect(index.search).toHaveBeenCalledTimes(1);
    expect(lastFilter()).toEqual(expect.arrayContaining([MATCH_NOTHING]));
  });

  test('no scope option at all matches nothing', async () => {
    await searchService.searchBottles('wine', {});
    expect(lastFilter()).toEqual(expect.arrayContaining([MATCH_NOTHING]));
  });

  test('a scope whose ids all strip to empty matches nothing (pre-existing guard kept)', async () => {
    await searchService.searchBottles('wine', { cellarIds: ['"', '""'] });
    expect(lastFilter()).toEqual(expect.arrayContaining([MATCH_NOTHING]));
  });

  test('a single cellar scopes to exactly that cellar', async () => {
    await searchService.searchBottles('wine', { cellarId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    const f = lastFilter();
    expect(f).toEqual(expect.arrayContaining(['cellarId = "aaaaaaaaaaaaaaaaaaaaaaaa"']));
    expect(f).not.toEqual(expect.arrayContaining([MATCH_NOTHING]));
  });

  test('several cellars scope to exactly those cellars, quotes stripped', async () => {
    await searchService.searchBottles('wine', { cellarIds: ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbb"bbbb'] });
    const f = lastFilter();
    expect(f).toEqual(expect.arrayContaining(['cellarId IN ["aaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbb"]']));
    expect(f).not.toEqual(expect.arrayContaining([MATCH_NOTHING]));
  });
});
