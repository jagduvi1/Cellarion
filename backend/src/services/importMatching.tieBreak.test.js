/**
 * The import's candidate finder: two registry entries with the same score.
 *
 * The matches were sorted by score alone, so entries that tied kept the order
 * the registry happened to return them in, which is not the same from one
 * call to the next. The first match is the one an import row is linked to, so
 * the same row could land on either entry. A tie now goes to the entry that
 * has been in the registry longer, whatever order the candidates arrive in.
 *
 * The search engine is off and WineDefinition answers the candidates it is
 * given, in the order it is given them.
 */

jest.mock('./search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }) }));
jest.mock('../models/Country', () => ({ findOne: jest.fn(() => ({ lean: async () => null })) }));
jest.mock('../models/WineDefinition', () => {
  const state = { candidates: [] };
  const chain = () => {
    const c = { populate: () => c, sort: () => c, limit: () => c, lean: async () => state.candidates.map((w) => ({ ...w })) };
    return c;
  };
  return { find: jest.fn(() => chain()), findOne: jest.fn(), __state: state };
});

const WineDefinition = require('../models/WineDefinition');
const { findWineMatches } = require('./importMatching');

const VIEWER = { userId: '64b000000000000000000001', roles: ['user'] };
const ITEM = { wineName: 'Chateau Margaux', producer: 'Chateau Margaux', country: 'France', region: 'Bordeaux' };

// The same wine entered twice: ids as MongoDB makes them, the first four bytes
// being the time the entry was created.
const OLDER = '69bd30cb212df2a8576cdd0e';
const NEWER = '6a6a494ae459d4a624347102';
const entry = (id, over = {}) => ({
  _id: { toString: () => id }, name: 'Château Margaux', producer: 'Château Margaux', appellation: '', type: 'red',
  country: { name: 'France' }, region: { name: 'Bordeaux' }, grapes: [], ...over,
});
const idsOf = (matches) => matches.map((m) => m.wine._id.toString());

beforeEach(() => { WineDefinition.__state.candidates = []; });

test('two entries that score the same come back older first, whichever order the registry returned them in', async () => {
  WineDefinition.__state.candidates = [entry(NEWER), entry(OLDER)];
  const newerFirst = await findWineMatches(ITEM, VIEWER);
  WineDefinition.__state.candidates = [entry(OLDER), entry(NEWER)];
  const olderFirst = await findWineMatches(ITEM, VIEWER);

  expect(newerFirst).toHaveLength(2);
  expect(newerFirst[0].score).toBe(newerFirst[1].score);
  expect(idsOf(newerFirst)).toEqual([OLDER, NEWER]);
  expect(idsOf(olderFirst)).toEqual([OLDER, NEWER]);
});

test('a better score still comes first, however new the entry is', async () => {
  // The older entry names another appellation, so it matches the row less well.
  WineDefinition.__state.candidates = [entry(OLDER, { name: 'Pavillon Rouge du Château Margaux' }), entry(NEWER)];
  const matches = await findWineMatches(ITEM, VIEWER);

  expect(idsOf(matches)[0]).toBe(NEWER);
  if (matches.length > 1) expect(matches[0].score).toBeGreaterThan(matches[1].score);
});

test('several ties are ordered by age throughout, and the list is the same on every call', async () => {
  const MIDDLE = '6a00000000000000000000aa';
  const orders = [[NEWER, MIDDLE, OLDER], [MIDDLE, OLDER, NEWER], [OLDER, NEWER, MIDDLE]];
  for (const order of orders) {
    WineDefinition.__state.candidates = order.map((id) => entry(id));
    expect(idsOf(await findWineMatches(ITEM, VIEWER))).toEqual([OLDER, MIDDLE, NEWER]);
  }
});
