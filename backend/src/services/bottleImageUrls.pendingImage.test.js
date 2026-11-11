/**
 * attachBottleImageUrls — the per-bottle "pending photo" that the cellar list
 * (BottleCard) renders when a bottle has no starred image and its wine has no
 * registry image.
 *
 * The cellar's card view must never show the RAW frame handed to the label
 * scanner — background and all — served from /api/uploads/originals/. That
 * frame is kept as a private kind:'label-scan' row so a curator can read a
 * misread label; it carries the wine it minted and sits at status 'uploaded'
 * with no processed file, so the by-wine arm of this lookup would match it on
 * every bottle of that wine. The lookup must exclude label scans.
 */
// Sibling lookup: the viewer's other bottles of
// the same wines. Empty unless a test says otherwise.
const mockBottleFind = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));
jest.mock('../models/Bottle', () => ({ find: (...a) => mockBottleFind(...a) }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const { attachBottleImageUrls } = require('./bottleImageUrls');

const USER = '64b000000000000000000001';
const WINE = '64b0000000000000000000aa';
const B1 = '64b0000000000000000000b1';
const B2 = '64b0000000000000000000b2';

// The pending lookup is find().sort().lean(); the starred-image lookup is
// find().lean(). One chain serves both.
const chain = (rows) => {
  const q = { sort: () => q, select: () => q, lean: async () => rows };
  return q;
};

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.find.mockReturnValue(chain([]));
});

test('the own-photo lookup excludes label scans, is scoped to the viewer, and includes APPROVED photos', async () => {
  const out = await attachBottleImageUrls([{ _id: B1, wineDefinition: WINE }], USER);

  expect(BottleImage.find).toHaveBeenCalledTimes(1);
  expect(BottleImage.find).toHaveBeenCalledWith(expect.objectContaining({
    uploadedBy: USER,
    // 'approved' is deliberate: approval must not drop a photo out of this
    // lookup and blank the card (discussion #1227).
    status: { $in: ['uploaded', 'processing', 'processed', 'approved'] },
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
  // Same wine, no pin and no vintage in common: the last resort, shown only
  // when the wine has no registry image.
  expect(out[1].pendingImageUrl).toBeNull();
  expect(out[1].otherVintageImageUrl).toBe('/api/uploads/processed/wine.png');
});

test('an approved own photo — public or private — still shows on the card', async () => {
  BottleImage.find.mockReturnValue(chain([
    { _id: 'appr', wineDefinition: WINE, bottle: B1, status: 'approved', visibility: 'private', originalUrl: null, processedUrl: '/api/uploads/processed/approved.png' },
  ]));

  const out = await attachBottleImageUrls([{ _id: B1, wineDefinition: WINE }], USER);
  expect(out[0].pendingImageUrl).toBe('/api/uploads/processed/approved.png');
});

test('a photo whose row carries no wine (uploaded while the bottle awaited its wine request) still reaches the sibling bottle', async () => {
  // Two identical bottles, the photo pinned to B1 with wineDefinition
  // null — B2 must show it too.
  BottleImage.find.mockReturnValue(chain([
    { _id: 'noWineRef', wineDefinition: null, bottle: B1, status: 'approved', originalUrl: null, processedUrl: '/api/uploads/processed/b1.png' },
  ]));
  const out = await attachBottleImageUrls([
    { _id: B1, wineDefinition: WINE, vintage: '2015' },
    { _id: B2, wineDefinition: WINE, vintage: '2015' },
  ], USER);
  expect(out[0].pendingImageUrl).toBe('/api/uploads/processed/b1.png');
  // The row carries no vintage tag of its own; its bottle's vintage counts.
  expect(out[1].pendingImageUrl).toBe('/api/uploads/processed/b1.png');
});

test('a sibling bottle that is NOT on this page still lends its photo, and only the viewer\'s own bottles are consulted', async () => {
  const S1 = '64b0000000000000000000c1';
  mockBottleFind.mockReturnValueOnce({ select: () => ({ lean: async () => [{ _id: S1, wineDefinition: WINE, vintage: '2015' }] }) });
  BottleImage.find.mockReturnValue(chain([
    { _id: 'sib', wineDefinition: null, bottle: S1, status: 'approved', originalUrl: null, processedUrl: '/api/uploads/processed/s1.png' },
  ]));
  const out = await attachBottleImageUrls([{ _id: B2, wineDefinition: WINE, vintage: '2015' }], USER);
  expect(mockBottleFind).toHaveBeenCalledWith({ user: USER, wineDefinition: { $in: [WINE] } });
  const query = BottleImage.find.mock.calls[0][0];
  expect(query.$or[0].bottle.$in).toEqual(expect.arrayContaining([S1, B2]));
  expect(out[0].pendingImageUrl).toBe('/api/uploads/processed/s1.png');
});

test('empty input is returned as-is without a query', async () => {
  expect(await attachBottleImageUrls([], USER)).toEqual([]);
  expect(BottleImage.find).not.toHaveBeenCalled();
});

/**
 * Photos per vintage. A photo carries its bottle's
 * vintage, and a card shows, in order: the bottle's own photo, the viewer's
 * photo of the same vintage, the vintage's official photo (the first of that
 * wine + vintage approved, or an admin's choice — vintageImageUrl), the wine's
 * registry image (client side), and only then the viewer's photo of another
 * vintage (otherVintageImageUrl). A 2015 label never stands in for a 2016
 * bottle while the wine has a picture.
 */
describe('attachBottleImageUrls and the photo\'s vintage', () => {
  const own2015 = { _id: 'own15', wineDefinition: WINE, bottle: null, vintage: '2015', originalUrl: null, processedUrl: '/api/uploads/processed/own-2015.webp' };
  const own2016 = { _id: 'own16', wineDefinition: WINE, bottle: null, vintage: '2016', originalUrl: null, processedUrl: '/api/uploads/processed/own-2016.webp' };
  const pub = (id, vintage, over = {}) => ({
    _id: id, wineDefinition: WINE, vintage, status: 'approved', visibility: 'public', createdAt: '2026-01-01T00:00:00Z',
    originalUrl: null, processedUrl: `/api/uploads/processed/${id}.webp`, ...over,
  });

  test('the viewer\'s own photo of the same vintage is used; one of another vintage is only the last resort', async () => {
    // Newest first, as the query sorts: the 2015 photo was taken last.
    BottleImage.find.mockReturnValue(chain([own2015, own2016]));
    const out = await attachBottleImageUrls([
      { _id: B1, wineDefinition: WINE, vintage: '2016' },
      { _id: B2, wineDefinition: WINE, vintage: '2017' },
    ], USER);
    expect(out[0].pendingImageUrl).toBe('/api/uploads/processed/own-2016.webp'); // same vintage beats newest
    expect(out[0].otherVintageImageUrl).toBeNull();
    expect(out[1].pendingImageUrl).toBeNull();                                         // no 2017 photo of its own…
    expect(out[1].otherVintageImageUrl).toBe('/api/uploads/processed/own-2015.webp'); // …the newest stands in last
  });

  test('the vintage official: the first photo of that wine and vintage approved, by anyone, with its credit — only for the vintages on the page', async () => {
    BottleImage.find
      .mockReturnValueOnce(chain([]))                                       // the viewer's own photos: none
      .mockReturnValueOnce(chain([                                          // published photos of the page's vintages
        pub('later16', '2016', { createdAt: '2026-05-01T00:00:00Z', credit: 'Bo' }),
        pub('first16', '2016', { createdAt: '2026-02-01T00:00:00Z', credit: 'Anna' }),
      ]));
    const out = await attachBottleImageUrls([
      { _id: B1, wineDefinition: WINE, vintage: '2016' },
      { _id: B2, wineDefinition: WINE, vintage: '2015' },
    ], USER);

    expect(BottleImage.find.mock.calls[1][0]).toEqual({
      status: 'approved',
      visibility: 'public',
      kind: { $ne: 'label-scan' },
      wineDefinition: { $in: [WINE] },
      vintage: { $in: ['2016', '2015'] },
    });
    expect(out[0].vintageImageUrl).toBe('/api/uploads/processed/first16.webp'); // a later upload never replaces it
    expect(out[0].vintageImageCredit).toBe('Anna');
    expect(out[1].vintageImageUrl).toBeNull(); // no 2015 photo: the card falls back to the wine's image
  });

  test('an admin\'s choice beats the wine\'s official image, which beats the first approved', async () => {
    const rows = [
      pub('first', '2016', { createdAt: '2026-01-01T00:00:00Z' }),
      pub('wineOfficial', '2016', { createdAt: '2026-03-01T00:00:00Z', assignedToWine: true }),
    ];
    BottleImage.find.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain(rows));
    let out = await attachBottleImageUrls([{ _id: B1, wineDefinition: WINE, vintage: '2016' }], USER);
    expect(out[0].vintageImageUrl).toBe('/api/uploads/processed/wineOfficial.webp');

    BottleImage.find.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain([
      ...rows, pub('chosen', '2016', { createdAt: '2026-06-01T00:00:00Z', assignedToVintage: true }),
    ]));
    out = await attachBottleImageUrls([{ _id: B1, wineDefinition: WINE, vintage: '2016' }], USER);
    expect(out[0].vintageImageUrl).toBe('/api/uploads/processed/chosen.webp');
  });

  test('bottles with no usable vintage (unknown, empty) ask for no vintage photo at all', async () => {
    BottleImage.find.mockReturnValue(chain([]));
    const out = await attachBottleImageUrls([
      { _id: B1, wineDefinition: WINE, vintage: 'Unknown' },
      { _id: B2, wineDefinition: WINE },
    ], USER);
    expect(BottleImage.find).toHaveBeenCalledTimes(1); // own photos only
    expect(out[0].vintageImageUrl).toBeNull();
  });
});
