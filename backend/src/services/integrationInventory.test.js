/**
 * The integrations' inventory (GET /api/inventory, docs/ha-push-events.md §4)
 * — the shaping and the loading. The route end to end, with tokens and the
 * scope rules, is routes/inventory.test.js.
 *
 * WHY THIS TEST EXISTS:
 * The field names are a contract with a separately released client (the Home
 * Assistant integration via pycellarion), so every field is pinned here.
 * Pinned too: the tasting profile is the STORED descriptors only (never the
 * prose, never a held profile, never curation bookkeeping); images are
 * thumbnail paths on this instance or null; a rack slot is reported as shelf
 * / row / col; and the loads project only what the answer carries, so the
 * heavy bottle fields are never read.
 */
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('./personalData', () => ({ listForBottles: jest.fn(async () => new Map()) }));
jest.mock('../utils/maturityUtils', () => ({
  ...jest.requireActual('../utils/maturityUtils'),
  buildProfileMap: jest.fn(async () => new Map()),
}));

const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const { listForBottles } = require('./personalData');
const {
  assembleInventory, buildInventory, profileOf, inventoryTag,
  BOTTLE_SELECT, RACK_SELECT, CELLAR_SELECT, PROFILE_SELECT, INVENTORY_WINE_POPULATE, INVENTORY_SCHEMA,
} = require('./integrationInventory');

const ME = 'u1';
const NOW_YEAR = new Date().getFullYear();
const OWN = { _id: 'c1', name: 'Home', user: ME, members: [] };
const SHARED = { _id: 'c2', name: 'Friend', user: 'u9', members: [{ user: ME, role: 'viewer' }] };
const COUNTRY = { _id: 'fr', name: 'France' };
const REGION = { _id: 'pa', name: 'Pauillac' };
const WINE = {
  _id: 'w1', name: 'Château X', producer: 'Château X', type: 'red', colour: null,
  country: COUNTRY, region: REGION, appellation: 'Pauillac', classification: null,
  grapes: [
    { _id: 'g1', name: 'Cabernet Sauvignon' },
    // A regional label for this wine's region (utils/grapeDisplay).
    { _id: 'g2', name: 'Tempranillo', regionalNames: [{ country: 'fr', region: 'pa', name: 'Tinta Pauillac' }] },
  ],
  image: '/api/uploads/processed/w1.webp',
};

const bottle = (over = {}) => ({
  _id: 'b1', cellar: 'c1', wineDefinition: WINE, vintage: '2015', bottleSize: '750ml',
  price: 350, currency: 'SEK', rating: 92, ratingScale: '100', notes: 'Decant',
  purchaseDate: new Date('2024-05-01T00:00:00Z'), purchaseLocation: 'Systembolaget',
  createdAt: new Date('2025-01-02T10:00:00Z'), openedAt: null, location: 'Basement, box 3',
  drinkFrom: NOW_YEAR - 1, drinkTo: NOW_YEAR + 10, peakFrom: NOW_YEAR + 2, peakUntil: NOW_YEAR + 6,
  ...over,
});

describe('assembleInventory — the contract', () => {
  const inv = (over = {}) => assembleInventory({
    userId: ME,
    cellars: [OWN, SHARED],
    racks: [{
      _id: 'r1', cellar: 'c1', name: 'Left cabinet', type: 'cabinet', rows: 3, cols: 6,
      typeConfig: { shelfRows: [1, 2, 1] }, slots: [{ position: 14, bottle: 'b1' }],
    }],
    bottles: [bottle({ defaultImageUrl: '/api/uploads/processed/own.webp' })],
    profiles: new Map([['w1', {
      body: 'full', acidity: 'medium', sweetness: 'dry', tannin: 'high',
      flavors: ['blackcurrant', 'cedar'], foodPairings: ['lamb'],
    }]]),
    personal: new Map([['b1', [{ key: 'Closure', type: 'enum', unit: null, value: 'cork', level: 'bottle', by: 'johan' }]]]),
    now: new Date('2026-10-21T12:00:00Z'),
    ...over,
  });

  test('top level: schema, time, cellars with the user\'s role, racks', () => {
    const s = inv();
    expect(Object.keys(s)).toEqual(['schema', 'generatedAt', 'cellars', 'racks', 'wines', 'bottles']);
    expect(s.schema).toBe(INVENTORY_SCHEMA);
    expect(s.generatedAt).toBe('2026-10-21T12:00:00.000Z');
    expect(s.cellars).toEqual([{ id: 'c1', name: 'Home', role: 'owner' }, { id: 'c2', name: 'Friend', role: 'viewer' }]);
    expect(s.racks).toEqual([{ id: 'r1', cellar: 'c1', name: 'Left cabinet' }]);
  });

  test('one bottle, every field', () => {
    const [b] = inv().bottles;
    expect(b).toEqual({
      id: 'b1',
      wine: 'w1',
      pending: null,
      cellar: 'c1',
      vintage: '2015',
      size: '750ml',
      price: 350,
      currency: 'SEK',
      rating: 92,
      ratingScale: '100',
      notes: 'Decant',
      purchaseDate: '2024-05-01',
      purchaseLocation: 'Systembolaget',
      addedAt: '2025-01-02T10:00:00.000Z',
      opened: false,
      maturity: 'early',
      window: { drinkFrom: NOW_YEAR - 1, peakFrom: NOW_YEAR + 2, peakUntil: NOW_YEAR + 6, drinkTo: NOW_YEAR + 10 },
      location: { rack: 'r1', rackName: 'Left cabinet', position: 14, shelf: 2, row: 2, col: 2 },
      place: 'Basement, box 3',
      image: '/api/uploads/thumbs/processed/own.webp.webp',
      personal: [{ key: 'Closure', type: 'enum', unit: null, value: 'cork', level: 'bottle', by: 'johan' }],
    });
  });

  test('one wine, every field — sent once, grapes by their display name', () => {
    const s = inv({ bottles: [bottle(), bottle({ _id: 'b2' })] });
    expect(Object.keys(s.wines)).toEqual(['w1']);
    expect(s.wines.w1).toEqual({
      name: 'Château X',
      producer: 'Château X',
      type: 'red',
      colour: null,
      country: 'France',
      region: 'Pauillac',
      appellation: 'Pauillac',
      classification: null,
      grapes: ['Cabernet Sauvignon', 'Tinta Pauillac'],
      image: '/api/uploads/thumbs/processed/w1.webp.webp',
      profile: {
        body: 'full', acidity: 'medium', sweetness: 'dry', tannin: 'high',
        flavors: ['blackcurrant', 'cedar'], foodPairings: ['lamb'],
      },
    });
  });

  test('a bottle waiting on a wine request: wine null, pending set', () => {
    const [b] = inv({ bottles: [bottle({ wineDefinition: null, pendingWineRequest: { _id: 'q1', wineName: 'Mystery', producer: 'Someone' } })] }).bottles;
    expect(b.wine).toBeNull();
    expect(b.pending).toEqual({ name: 'Mystery', producer: 'Someone' });
  });

  test('nothing set → nulls, never undefined; a scale only beside a rating', () => {
    const [b] = inv({
      racks: [],
      personal: new Map(),
      bottles: [{
        _id: 'b9', cellar: 'c1', wineDefinition: null, vintage: 'NV', ratingScale: '5', createdAt: new Date('2025-01-02T10:00:00Z'),
        notes: '   ', openedAt: new Date(),
      }],
    }).bottles;
    expect(b).toMatchObject({
      wine: null, pending: null, size: null, price: null, currency: null, rating: null, ratingScale: null,
      notes: null, purchaseDate: null, purchaseLocation: null, opened: true, maturity: null,
      window: { drinkFrom: null, peakFrom: null, peakUntil: null, drinkTo: null },
      location: null, place: null, image: null, personal: [],
    });
    expect(JSON.stringify(b)).not.toMatch(/undefined/);
    expect(Object.values(b).some((v) => v === undefined)).toBe(false);
  });

  test('the window is the curated one when the bottle has none of its own', () => {
    const profileMap = new Map([['w1:2015', { status: 'reviewed', earlyFrom: 2020, peakFrom: 2024, peakUntil: 2030, lateUntil: 2035 }]]);
    const [b] = inv({
      profileMap,
      bottles: [bottle({ drinkFrom: undefined, drinkTo: undefined, peakFrom: undefined, peakUntil: undefined })],
    }).bottles;
    expect(b.window).toEqual({ drinkFrom: 2020, peakFrom: 2024, peakUntil: 2030, drinkTo: 2035 });
    expect(b.maturity).toEqual(expect.any(String));
  });

  test('a grid slot is row / col; another rack type keeps only its position', () => {
    const s = inv({
      racks: [
        { _id: 'r2', cellar: 'c1', name: 'Wall', type: 'grid', rows: 4, cols: 6, slots: [{ position: 8, bottle: 'b1' }] },
        { _id: 'r3', cellar: 'c1', name: 'Hex', type: 'hex', rows: 4, cols: 6, slots: [{ position: 3, bottle: 'b2' }] },
      ],
      bottles: [bottle(), bottle({ _id: 'b2' })],
    });
    expect(s.bottles[0].location).toEqual({ rack: 'r2', rackName: 'Wall', position: 8, shelf: null, row: 2, col: 2 });
    expect(s.bottles[1].location).toEqual({ rack: 'r3', rackName: 'Hex', position: 3, shelf: null, row: null, col: null });
  });

  test('leftovers of a cellar not in the list (soft-deleted) are dropped, bottles and racks', () => {
    const s = inv({
      racks: [{ _id: 'rX', cellar: 'c-gone', name: 'Old', slots: [] }],
      bottles: [bottle(), bottle({ _id: 'bX', cellar: 'c-gone' })],
    });
    expect(s.bottles.map((b) => b.id)).toEqual(['b1']);
    expect(s.racks).toEqual([]);
  });
});

describe('images: the card picture as a thumbnail path, or null', () => {
  const imageOf = (over) => assembleInventory({ userId: ME, cellars: [OWN], racks: [], bottles: [bottle(over)] }).bottles[0].image;
  const wineImage = (image) => assembleInventory({
    userId: ME, cellars: [OWN], racks: [], bottles: [bottle({ wineDefinition: { ...WINE, image } })],
  }).wines.w1.image;

  test('the BottleCard order: default → own → vintage → registry → another vintage', () => {
    const all = {
      defaultImageUrl: '/api/uploads/processed/default.webp',
      pendingImageUrl: '/api/uploads/processed/own.webp',
      vintageImageUrl: '/api/uploads/processed/vintage.webp',
      otherVintageImageUrl: '/api/uploads/processed/other.webp',
    };
    expect(imageOf(all)).toBe('/api/uploads/thumbs/processed/default.webp.webp');
    expect(imageOf({ ...all, defaultImageUrl: null })).toBe('/api/uploads/thumbs/processed/own.webp.webp');
    expect(imageOf({ ...all, defaultImageUrl: null, pendingImageUrl: null })).toBe('/api/uploads/thumbs/processed/vintage.webp.webp');
    expect(imageOf({ otherVintageImageUrl: all.otherVintageImageUrl })).toBe('/api/uploads/thumbs/processed/w1.webp.webp');
    expect(imageOf({ otherVintageImageUrl: all.otherVintageImageUrl, wineDefinition: { ...WINE, image: null } }))
      .toBe('/api/uploads/thumbs/processed/other.webp.webp');
  });

  test('an inline data: registry image counts as none (the offline copy\'s rule)', () => {
    expect(imageOf({ otherVintageImageUrl: '/api/uploads/originals/o.jpg', wineDefinition: { ...WINE, image: 'data:image/png;base64,AAA' } }))
      .toBe('/api/uploads/thumbs/originals/o.jpg.webp');
    expect(wineImage('data:image/png;base64,AAA')).toBeNull();
  });

  test('an external picture is the card\'s picture, so the answer is null — never a foreign URL', () => {
    expect(imageOf({ defaultImageUrl: 'https://example.com/x.jpg' })).toBeNull();
    expect(wineImage('https://example.com/label.jpg')).toBeNull();
    expect(wineImage('processed/abc.png')).toBe('/api/uploads/thumbs/processed/abc.png.webp');
  });
});

describe('profileOf — stored descriptors only', () => {
  test('a held profile is null, whatever it still stores', () => {
    expect(profileOf({ heldAt: new Date(), body: 'full', flavors: ['x'] })).toBeNull();
  });

  test('none, or an all-empty default subdoc, is null', () => {
    expect(profileOf(null)).toBeNull();
    expect(profileOf({ body: null, tannin: null, acidity: null, sweetness: null, flavors: [], foodPairings: [] })).toBeNull();
  });

  test('lists are capped at 12; nothing but the six descriptors leaves', () => {
    const p = profileOf({
      body: 'light', flavors: Array.from({ length: 20 }, (_, i) => `f${i}`), foodPairings: ['a', '', null, 'b'],
      description: 'Long AI prose', confidence: 0.4, producerSuspect: true, producerNote: 'x', heldReason: 'y',
      source: 'ai', verifiedBy: 'u5', model: 'claude',
    });
    expect(Object.keys(p)).toEqual(['body', 'acidity', 'sweetness', 'tannin', 'flavors', 'foodPairings']);
    expect(p.flavors).toHaveLength(12);
    expect(p.foodPairings).toEqual(['a', 'b']);
  });
});

describe('buildInventory — what is loaded', () => {
  const chain = (result, record = {}) => {
    const q = {
      select: (s) => { record.select = s; return q; },
      populate: (p) => { record.populate = p; return q; },
      sort: () => q,
      lean: async () => result,
    };
    return q;
  };

  test('the scope is the offline snapshot\'s; every load projects; one profile query for all wines', async () => {
    const rec = { cellar: {}, bottle: {}, rack: {}, wine: {} };
    Cellar.find.mockReturnValue(chain([OWN, SHARED], rec.cellar));
    Bottle.find.mockReturnValue(chain([bottle()], rec.bottle));
    Rack.find.mockReturnValue(chain([], rec.rack));
    WineDefinition.find.mockReturnValue(chain([{ _id: 'w1', aiProfile: { body: 'full', heldAt: null } }], rec.wine));
    const attach = jest.fn(async (bs) => bs);

    const s = await buildInventory(ME, { attachBottleImageUrls: attach });

    expect(Cellar.find).toHaveBeenCalledWith({ $or: [{ user: ME }, { 'members.user': ME }], deletedAt: null });
    const bq = Bottle.find.mock.calls[0][0];
    expect(bq.cellar).toEqual({ $in: ['c1', 'c2'] });
    expect(bq.status.$nin).toEqual(expect.arrayContaining(['drank', 'gifted', 'sold', 'other', 'ordered']));
    expect(Rack.find).toHaveBeenCalledWith({ cellar: { $in: ['c1', 'c2'] }, deletedAt: null });
    expect(WineDefinition.find).toHaveBeenCalledTimes(1);
    expect(WineDefinition.find).toHaveBeenCalledWith({ _id: { $in: ['w1'] } });
    expect(attach).toHaveBeenCalledWith(expect.any(Array), ME);
    expect(listForBottles).toHaveBeenCalledWith(expect.any(Array), [OWN, SHARED]);
    expect(rec.cellar.select).toBe(CELLAR_SELECT);
    expect(rec.bottle.select).toBe(BOTTLE_SELECT);
    expect(rec.bottle.populate).toBe(INVENTORY_WINE_POPULATE);
    expect(rec.rack.select).toBe(RACK_SELECT);
    expect(rec.wine.select).toBe(PROFILE_SELECT);
    expect(s.wines.w1.profile).toEqual({ body: 'full', acidity: null, sweetness: null, tannin: null, flavors: [], foodPairings: [] });
  });

  test('projections: inclusion lists that leave the heavy and internal fields out', () => {
    const words = (s) => s.split(/\s+/);
    for (const heavy of ['cellarHistory', 'pours', 'barcode', 'purchaseUrl', 'occasion', 'reservedFor', 'consumedNote', 'user']) {
      expect(words(BOTTLE_SELECT)).not.toContain(heavy);
    }
    expect(BOTTLE_SELECT).not.toMatch(/-/); // inclusion only — nothing loads by default
    expect(RACK_SELECT).not.toMatch(/rfid|zones/);
    expect(words(RACK_SELECT)).toEqual(expect.arrayContaining(['slots.position', 'slots.bottle']));
    expect(PROFILE_SELECT.split(' ').sort()).toEqual([
      'aiProfile.acidity', 'aiProfile.body', 'aiProfile.flavors', 'aiProfile.foodPairings',
      'aiProfile.heldAt', 'aiProfile.sweetness', 'aiProfile.tannin',
    ]);
    const wine = INVENTORY_WINE_POPULATE.find((p) => p.path === 'wineDefinition');
    expect(wine.select).not.toMatch(/aiProfile|scan|contribution|createdBy|lwin/);
    expect(wine.populate).toEqual([
      { path: 'country', select: 'name' },
      { path: 'region', select: 'name' },
      { path: 'grapes', select: 'name regionalNames' },
    ]);
  });

  test('no cellars → an empty inventory without further queries', async () => {
    Cellar.find.mockReturnValue(chain([]));
    Bottle.find.mockClear();
    Rack.find.mockClear();
    WineDefinition.find.mockClear();
    const s = await buildInventory(ME, { attachBottleImageUrls: jest.fn() });
    expect(s).toMatchObject({ schema: 1, cellars: [], racks: [], wines: {}, bottles: [] });
    expect(Bottle.find).not.toHaveBeenCalled();
    expect(Rack.find).not.toHaveBeenCalled();
    expect(WineDefinition.find).not.toHaveBeenCalled();
  });
});

describe('inventoryTag', () => {
  test('the offline snapshot\'s validator in its own tag space', async () => {
    const { snapshotTag } = require('./offlineSnapshot');
    const q = { select: () => q, lean: async () => [] };
    Cellar.find.mockReturnValue(q);
    const t = 1000 * 30 * 60 * 1000 + 60 * 1000;
    const inv = await inventoryTag(ME, t);
    expect(inv).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(inv).not.toBe(await snapshotTag(ME, t));
    expect(inv).toBe(await snapshotTag(ME, t, { salt: 'inventory:1' }));
  });
});
