/**
 * Barcode → wine, learned from members' bottles.
 *
 * WHY THIS TEST EXISTS:
 * The answer is shared across members, so it must be hard to poison and must
 * never leak: owners are counted (twelve bottles from one member are one
 * vote), a wine the viewer may not see (someone's pending row or private
 * draft) is skipped rather than revealed, and a vintage is suggested only when
 * the code is clearly vintage-specific.
 */
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));

const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { lookupBarcode } = require('./barcodeLookup');

const VIEWER = { userId: 'viewer', roles: ['user'] };
const chain = (doc) => ({ select: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue(doc) }) });
const wine = (id, extra = {}) => ({ _id: id, name: `Wine ${id}`, producer: 'P', grapes: [], createdBy: 'someone', ...extra });

beforeEach(() => jest.clearAllMocks());

it('groups by wine and counts distinct owners, most confirmed first', async () => {
  Bottle.aggregate.mockResolvedValue([{ _id: 'w1', owners: 3, vintages: [['2019'], ['2020'], ['2019']], last: new Date() }]);
  WineDefinition.findById.mockReturnValue(chain(wine('w1')));

  const out = await lookupBarcode('4006381333931', VIEWER);

  expect(out).toMatchObject({ wine: { _id: 'w1', name: 'Wine w1' }, owners: 3, vintage: null });
  expect(out.wine).not.toHaveProperty('createdBy');
  const pipeline = Bottle.aggregate.mock.calls[0][0];
  expect(pipeline[0]).toEqual({ $match: { barcode: '4006381333931' } });
  expect(pipeline[1].$group._id).toEqual({ wine: '$wineDefinition', user: '$user' });
  expect(pipeline[3]).toEqual({ $sort: { owners: -1, last: -1 } });
});

it('suggests the vintage only when two or more owners agree on one', async () => {
  Bottle.aggregate.mockResolvedValue([{ _id: 'w1', owners: 2, vintages: [['2019'], ['2019']], last: new Date() }]);
  WineDefinition.findById.mockReturnValue(chain(wine('w1')));
  expect((await lookupBarcode('4006381333931', VIEWER)).vintage).toBe('2019');

  Bottle.aggregate.mockResolvedValue([{ _id: 'w1', owners: 1, vintages: [['2019']], last: new Date() }]);
  expect((await lookupBarcode('4006381333931', VIEWER)).vintage).toBeNull();
});

it('skips a wine the viewer may not see and answers with the next one', async () => {
  Bottle.aggregate.mockResolvedValue([
    { _id: 'hidden', owners: 5, vintages: [], last: new Date() },
    { _id: 'w2', owners: 1, vintages: [['NV']], last: new Date() },
  ]);
  WineDefinition.findById.mockImplementation((id) => chain(id === 'hidden'
    ? wine('hidden', { draft: true, createdBy: 'someone-else' })
    : wine('w2')));

  const out = await lookupBarcode('4006381333931', VIEWER);
  expect(out.wine._id).toBe('w2');
  expect(out.owners).toBe(1);
});

it('answers wine:null for a code nobody has added yet', async () => {
  Bottle.aggregate.mockResolvedValue([]);
  expect(await lookupBarcode('4006381333931', VIEWER)).toEqual({ wine: null });
});
