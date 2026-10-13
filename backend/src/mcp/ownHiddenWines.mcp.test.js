/**
 * search_registry / get_wine and a member's own quarantined drinks
 * (2026-10-13): listed first for the member who has them, flagged, readable
 * by id for them — and for nobody else, never on the anonymous surface.
 */
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn(), findById: jest.fn() }));
jest.mock('../services/wineProposalOps', () => ({ pendingForWine: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: jest.fn() }));
jest.mock('../services/registryReadTracker', () => ({
  gateMcpRead: jest.fn(async () => ({ allowed: true })), CAP_MESSAGE: 'cap',
}));
jest.mock('../utils/siteUrl', () => ({ siteBaseUrl: () => 'https://cellarion.app' }));
jest.mock('../services/ownHiddenWines', () => ({ findOwnHiddenWineIds: jest.fn(), isOwnHiddenWine: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const { findOwnHiddenWineIds, isOwnHiddenWine } = require('../services/ownHiddenWines');
const { allTools } = require('./registry');
require('./tools/wines');

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const oid = (c) => c.repeat(24);
const BEER = oid('b');
const WINE = oid('c');
const CTX = { user: { id: oid('1'), roles: ['user'] } };

// find(...).select().populate().lean() and the text-search variant with .sort().limit().
const listChain = (rows) => {
  const q = {};
  for (const m of ['select', 'populate', 'sort', 'limit']) q[m] = jest.fn(() => q);
  q.lean = jest.fn().mockResolvedValue(rows);
  return q;
};
const oneChain = (doc) => ({
  select: jest.fn().mockReturnValue({
    populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
  }),
});
const beer = { _id: BEER, name: 'Pale Lager', producer: 'Example Brewery', slug: 'example-brewery-pale-lager', grapes: [] };
const wine = { _id: WINE, name: 'Blanc', producer: 'Example Estate', slug: 'example-estate-blanc', grapes: [] };

beforeEach(() => jest.clearAllMocks());

describe('search_registry', () => {
  test('the signed-in caller\'s own hidden drink comes first, flagged', async () => {
    findOwnHiddenWineIds.mockResolvedValue([BEER]);
    WineDefinition.find.mockReturnValueOnce(listChain([beer])).mockReturnValueOnce(listChain([wine]));

    const body = parse(await tool('search_registry').handler({ query: 'lager' }, CTX));

    expect(findOwnHiddenWineIds).toHaveBeenCalledWith(CTX.user.id, 'lager');
    expect(WineDefinition.find.mock.calls[0][0]).toEqual({ _id: { $in: [BEER] }, nonWine: true });
    expect(body.data.map((w) => w.wine_id)).toEqual([BEER, WINE]);
    expect(body.data[0].only_in_your_cellar).toBe(true);
    expect(body.data[1].only_in_your_cellar).toBeUndefined();
    expect(body.summary).toMatch(/1 registry match\(es\).*\+ 1 of the user's own drink/);
  });

  test('the anonymous surface never looks', async () => {
    WineDefinition.find.mockReturnValue(listChain([wine]));
    const body = parse(await tool('search_registry').handler({ query: 'lager' }, { anonymous: true }));
    expect(findOwnHiddenWineIds).not.toHaveBeenCalled();
    expect(body.data.map((w) => w.wine_id)).toEqual([WINE]);
  });

  test('a failed lookup still answers the registry search', async () => {
    findOwnHiddenWineIds.mockRejectedValue(new Error('db down'));
    WineDefinition.find.mockReturnValue(listChain([wine]));
    const body = parse(await tool('search_registry').handler({ query: 'lager' }, CTX));
    expect(body.data.map((w) => w.wine_id)).toEqual([WINE]);
  });
});

describe('get_wine', () => {
  test('the caller\'s own hidden drink reads by id, flagged, with no public page', async () => {
    WineDefinition.findOne
      .mockReturnValueOnce(oneChain(null)) // the ordinary visibility query refuses it
      .mockReturnValueOnce(oneChain(beer));
    isOwnHiddenWine.mockResolvedValue(true);

    const body = parse(await tool('get_wine').handler({ wine_id: BEER }, CTX));

    expect(isOwnHiddenWine).toHaveBeenCalledWith(CTX.user.id, BEER);
    expect(WineDefinition.findOne.mock.calls[1][0]).toEqual({ _id: BEER, nonWine: true });
    expect(body.data.only_in_your_cellar).toBe(true);
    expect(body.data.public_url).toBeNull();
  });

  test('someone else\'s hidden drink is the same not_found a missing id gets', async () => {
    WineDefinition.findOne.mockReturnValue(oneChain(null));
    isOwnHiddenWine.mockResolvedValue(false);
    const body = parse(await tool('get_wine').handler({ wine_id: BEER }, CTX));
    expect(body.error.code).toBe('not_found');
    expect(WineDefinition.findOne).toHaveBeenCalledTimes(1);
  });

  test('the anonymous surface never asks', async () => {
    WineDefinition.findOne.mockReturnValue(oneChain(null));
    const body = parse(await tool('get_wine').handler({ wine_id: BEER }, { anonymous: true }));
    expect(body.error.code).toBe('not_found');
    expect(isOwnHiddenWine).not.toHaveBeenCalled();
  });

  test('an ordinary wine is not flagged', async () => {
    WineDefinition.findOne.mockReturnValue(oneChain(wine));
    const body = parse(await tool('get_wine').handler({ wine_id: WINE }, CTX));
    expect(body.data.only_in_your_cellar).toBeUndefined();
    expect(body.data.public_url).toBe('https://cellarion.app/wines/example-estate-blanc');
    expect(isOwnHiddenWine).not.toHaveBeenCalled();
  });
});
