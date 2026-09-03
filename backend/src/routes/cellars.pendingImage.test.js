/**
 * routes/cellars attachBottleImageUrls — the per-bottle "pending photo" that
 * the cellar list (BottleCard) renders when a bottle has no starred image and
 * its wine has no registry image.
 *
 * Support ticket 2026-09-03: the cellar's card view showed the RAW frame a
 * user had handed to the label scanner — background and all — served from
 * /api/uploads/originals/. That frame is kept as a private kind:'label-scan'
 * row so a curator can read a misread label; it carries the wine it minted
 * and sits at status 'uploaded' with no processed file, so the by-wine arm of
 * this lookup (added 2026-08-03, before label scans existed) matched it on
 * every bottle of that wine. The lookup must exclude label scans.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../services/search', () => ({
  indexBottle: jest.fn(), removeBottle: jest.fn(), indexWine: jest.fn(),
  bulkIndexBottles: jest.fn(), getIsAvailable: jest.fn(() => false),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({ createCellar: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/cellarTransfer', () => ({ transferCellarOwnership: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendCellarInviteEmail: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getSnapshotsForDates: jest.fn(), getOrCreateDailySnapshot: jest.fn(), convertCurrency: jest.fn(),
}));
jest.mock('../models/Cellar', () => ({}));
jest.mock('../models/Bottle', () => ({}));
jest.mock('../models/Rack', () => ({}));
jest.mock('../models/User', () => ({}));
jest.mock('../models/AuditLog', () => ({}));
jest.mock('../models/WineDefinition', () => ({}));
jest.mock('../models/PendingShare', () => ({}));
jest.mock('../models/ClimateDevice', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const { attachBottleImageUrls } = require('./cellars');

const USER = '64b000000000000000000001';
const WINE = '64b0000000000000000000aa';
const B1 = '64b0000000000000000000b1';
const B2 = '64b0000000000000000000b2';

// The pending lookup is find().sort().lean(); the starred-image lookup is
// find().lean(). One chain serves both.
const chain = (rows) => {
  const q = { sort: () => q, lean: async () => rows };
  return q;
};

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.find.mockReturnValue(chain([]));
});

test('the pending lookup excludes label scans and is scoped to the viewer', async () => {
  const out = await attachBottleImageUrls([{ _id: B1, wineDefinition: WINE }], USER);

  expect(BottleImage.find).toHaveBeenCalledTimes(1);
  expect(BottleImage.find).toHaveBeenCalledWith(expect.objectContaining({
    uploadedBy: USER,
    status: { $in: ['uploaded', 'processing', 'processed'] },
    // `$ne`, not `kind: 'bottle'` — rows older than the field have no kind.
    kind: { $ne: 'label-scan' },
  }));
  expect(out[0].pendingImageUrl).toBeNull();
  expect(out[0].defaultImageUrl).toBeNull();
});

test('a photo pinned to the bottle beats one that merely matches the wine, and the processed file is what shows', async () => {
  BottleImage.find.mockReturnValue(chain([
    { _id: 'byWine', wineDefinition: WINE, bottle: null, originalUrl: null, processedUrl: '/api/uploads/processed/wine.png' },
    { _id: 'byBottle', wineDefinition: WINE, bottle: B1, originalUrl: null, processedUrl: '/api/uploads/processed/b1.png' },
  ]));

  const out = await attachBottleImageUrls([
    { _id: B1, wineDefinition: WINE },
    { _id: B2, wineDefinition: WINE },
  ], USER);

  expect(out[0].pendingImageUrl).toBe('/api/uploads/processed/b1.png');   // pinned to B1
  expect(out[1].pendingImageUrl).toBe('/api/uploads/processed/wine.png'); // same wine, no pin
});

test('empty input is returned as-is without a query', async () => {
  expect(await attachBottleImageUrls([], USER)).toEqual([]);
  expect(BottleImage.find).not.toHaveBeenCalled();
});
