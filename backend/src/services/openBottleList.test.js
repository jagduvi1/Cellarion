/**
 * The cellar page's "Open now" strip: the open bottles of the cellars in
 * view, active only, most urgent first (drink-by deadline), at most
 * OPEN_NOW_MAX.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['select', 'populate', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  return c;
};

jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
const Bottle = require('../models/Bottle');
const { listOpenBottles, OPEN_NOW_MAX } = require('./openBottleList');

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY);

beforeEach(() => jest.clearAllMocks());

test('asks for the active, opened bottles of the given cellars', async () => {
  Bottle.find.mockReturnValue(chain([]));
  await listOpenBottles(['c1', 'c2']);
  expect(Bottle.find).toHaveBeenCalledWith({ cellar: { $in: ['c1', 'c2'] }, status: 'active', openedAt: { $ne: null } });
});

test('most urgent first: by drink-by deadline, not by when it was opened', async () => {
  const coravin = { _id: 'a', openedAt: ago(10), preservationMethod: 'coravin' }; // 80 days left
  const recorked = { _id: 'b', openedAt: ago(1), preservationMethod: 'recorked' }; // 1 day left
  const vacuum = { _id: 'c', openedAt: ago(2), preservationMethod: 'vacuum' }; // 2 days left
  Bottle.find.mockReturnValue(chain([coravin, recorked, vacuum]));
  expect((await listOpenBottles(['c1'])).map((b) => b._id)).toEqual(['b', 'c', 'a']);
});

test('no cellars: no query; many open bottles: the strip shows the first OPEN_NOW_MAX', async () => {
  expect(await listOpenBottles([])).toEqual([]);
  expect(Bottle.find).not.toHaveBeenCalled();

  const many = Array.from({ length: OPEN_NOW_MAX + 5 }, (_, i) => ({ _id: `b${i}`, openedAt: ago(i / 10), preservationMethod: 'vacuum' }));
  Bottle.find.mockReturnValue(chain(many));
  expect(await listOpenBottles(['c1'])).toHaveLength(OPEN_NOW_MAX);
});
