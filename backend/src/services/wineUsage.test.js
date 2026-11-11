/**
 * services/wineUsage — how many bottles members hold of each registry wine,
 * as the admin queues show it beside a wine.
 */

jest.mock('../models/Bottle', () => ({ aggregate: jest.fn() }));

const Bottle = require('../models/Bottle');
const { bottleCountsByWine } = require('./wineUsage');

beforeEach(() => jest.clearAllMocks());

describe('bottleCountsByWine', () => {
  test('counts the bottles of the given wines in one aggregate, keyed by the wine id as a string', async () => {
    const idA = { toString: () => 'a' };
    Bottle.aggregate.mockResolvedValue([{ _id: idA, count: 4 }, { _id: 'b', count: 1 }]);

    const counts = await bottleCountsByWine([idA, 'b', 'c']);

    expect(Bottle.aggregate).toHaveBeenCalledTimes(1);
    expect(Bottle.aggregate).toHaveBeenCalledWith([
      { $match: { wineDefinition: { $in: [idA, 'b', 'c'] } } },
      { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
    ]);
    expect([...counts]).toEqual([['a', 4], ['b', 1]]);
  });

  test('a wine nobody holds is absent from the map', async () => {
    Bottle.aggregate.mockResolvedValue([]);

    const counts = await bottleCountsByWine(['c']);

    expect(counts.get('c')).toBeUndefined();
    expect(counts.size).toBe(0);
  });

  test('with no wine to count, the database is not asked', async () => {
    const counts = await bottleCountsByWine([]);

    expect(counts.size).toBe(0);
    expect(Bottle.aggregate).not.toHaveBeenCalled();
  });
});
