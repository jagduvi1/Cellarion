/**
 * The queue-row projection when a wine carries a BACK label frame.
 *
 * The row is what both curator surfaces read — the web modal renders thumbnails
 * from it and the MCP tool reprojects it — so the two things that matter are
 * that the back frame's id and URL actually reach the row, and that the
 * per-row URL scoping is preserved (a shared map repeated on 25 rows is 25
 * copies of the same payload).
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('./crossFieldScan', () => ({ detectCrossFieldForValues: jest.fn().mockResolvedValue(null) }));
jest.mock('./search', () => ({
  indexWine: jest.fn().mockResolvedValue(undefined),
  bulkIndexBottles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateRegion: jest.fn() }));
jest.mock('./wineProfileOps', () => ({
  resolveGrapeIdsStrict: jest.fn(),
  GRAPES_MAX: 20, GRAPE_NAME_MAX: 200,
  WINE_TYPES: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
}));

const WineDefinition = require('../models/WineDefinition');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const { queryPendingWines } = require('./pendingWineOps');

const FRONT = 'scan-front';
const BACK = 'scan-back';

const chain = (rows) => {
  const c = {};
  for (const m of ['sort', 'skip', 'limit', 'populate', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn().mockResolvedValue(rows);
  return c;
};

/** One pending wine carrying both label frames and a recorded disagreement. */
const prime = (wineOver = {}, scanRows = null) => {
  WineDefinition.find.mockReturnValue(chain([{
    _id: 'wine-1', name: 'Kaefferkopf', producer: '', createdAt: new Date(0), createdVia: 'ui',
    grapes: [], scanImage: FRONT, scanImageBack: BACK,
    scanFieldConflicts: [{ field: 'producer', front: 'Cave', back: 'Wolfberger' }],
    ...wineOver,
  }]));
  WineDefinition.countDocuments.mockResolvedValue(1);
  Bottle.find.mockReturnValue(chain([]));
  // Two calls: bottle photos, then the scan frames the wine points at.
  let call = 0;
  BottleImage.find.mockImplementation(() => {
    call += 1;
    if (call === 1) return chain([]); // bottle gallery photos
    return chain(scanRows ?? [
      { _id: FRONT, originalUrl: '/api/uploads/originals/front.jpg' },
      { _id: BACK, originalUrl: '/api/uploads/originals/back.jpg' },
    ]);
  });
};

beforeEach(() => jest.clearAllMocks());

describe('queryPendingWines — the back frame on the row', () => {
  test('both frames are looked up in ONE query and both ids reach the row', async () => {
    prime();
    const { rows } = await queryPendingWines({});

    // The second BottleImage.find is the scan lookup: the wine POINTS at these,
    // so there is no wineDefinition/bottle link to find them by.
    expect(BottleImage.find.mock.calls[1][0]).toEqual({ _id: { $in: [FRONT, BACK] } });
    expect(rows[0].scanImageId).toBe(FRONT);
    expect(rows[0].scanImageBackId).toBe(BACK);
  });

  test('both URLs are in the row-scoped map, so an <img> can render either', async () => {
    prime();
    const { rows } = await queryPendingWines({});

    expect(rows[0].imageUrls).toEqual({
      [FRONT]: '/api/uploads/originals/front.jpg',
      [BACK]: '/api/uploads/originals/back.jpg',
    });
  });

  test('the recorded disagreement rides along, normalised to plain field/front/back', async () => {
    prime();
    const { rows } = await queryPendingWines({});

    expect(rows[0].scanFieldConflicts).toEqual([
      { field: 'producer', front: 'Cave', back: 'Wolfberger' },
    ]);
  });

  test('a one-frame row reports a null back id and an empty conflict list', async () => {
    prime({ scanImageBack: null, scanFieldConflicts: [] },
      [{ _id: FRONT, originalUrl: '/api/uploads/originals/front.jpg' }]);
    const { rows } = await queryPendingWines({});

    expect(rows[0].scanImageBackId).toBeNull();
    expect(rows[0].scanFieldConflicts).toEqual([]);
    expect(rows[0].imageUrls).toEqual({ [FRONT]: '/api/uploads/originals/front.jpg' });
  });

  test('a row predating the fields is not broken by their absence', async () => {
    prime({ scanImageBack: undefined, scanFieldConflicts: undefined },
      [{ _id: FRONT, originalUrl: '/api/uploads/originals/front.jpg' }]);
    const { rows } = await queryPendingWines({});

    expect(rows[0].scanImageBackId).toBeNull();
    expect(rows[0].scanFieldConflicts).toEqual([]);
  });
});
