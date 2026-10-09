/**
 * services/vintageImages.findVintageOfficials — one query for a page's
 * (wine, vintage) pairs, published photos only, and the rule from
 * utils/imageVintage.pickVintageOfficials (support ticket 2026-10-09).
 */
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));
const BottleImage = require('../models/BottleImage');
const { findVintageOfficials } = require('./vintageImages');

const chain = (rows) => { const q = { select: () => q, lean: async () => rows }; return q; };

beforeEach(() => jest.clearAllMocks());

test('one query, published non-scan photos of the asked wines and vintages; the first approved wins, files only', async () => {
  BottleImage.find.mockReturnValue(chain([
    { _id: 'late', wineDefinition: 'w1', vintage: '2016', createdAt: '2026-05-01', processedUrl: '/p/late.webp', credit: 'Bo' },
    { _id: 'gone', wineDefinition: 'w1', vintage: '2016', createdAt: '2026-01-01', processedUrl: null, originalUrl: null },
    { _id: 'first', wineDefinition: 'w1', vintage: '2016', createdAt: '2026-02-01', processedUrl: null, originalUrl: '/o/first.jpg', credit: null },
  ]));
  const out = await findVintageOfficials(['w1'], ['2016']);
  expect(BottleImage.find).toHaveBeenCalledTimes(1);
  expect(BottleImage.find).toHaveBeenCalledWith({
    status: 'approved', visibility: 'public', kind: { $ne: 'label-scan' },
    wineDefinition: { $in: ['w1'] }, vintage: { $in: ['2016'] },
  });
  // The row with no file behind it never represents a vintage.
  expect(out.get('w1::2016')).toEqual({ _id: 'first', url: '/o/first.jpg', credit: null });
});

test('no wines or no vintages: no query at all', async () => {
  expect((await findVintageOfficials([], ['2016'])).size).toBe(0);
  expect((await findVintageOfficials(['w1'], [])).size).toBe(0);
  expect(BottleImage.find).not.toHaveBeenCalled();
});
