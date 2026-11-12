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
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
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
  assembleInventory, buildInventory, profileOf, inventoryTag, parseInclude, CONSUMED_LIMIT,
  BOTTLE_SELECT, CONSUMED_SELECT, RACK_SELECT, CELLAR_SELECT, PROFILE_SELECT, INVENTORY_WINE_POPULATE, INVENTORY_SCHEMA,
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
      status: 'active',
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
      consumed: null,
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
      displayName: 'Château X', // no label sweetness term: the name as it is
      producer: 'Château X',
      type: 'red',
      category: 'wine',
      colour: null,
      country: 'France',
      region: 'Pauillac',
      appellation: 'Pauillac',
      classification: null,
      labelSweetness: null,
      sweetnessStyle: null,
      grapes: ['Cabernet Sauvignon', 'Tinta Pauillac'],
      image: '/api/uploads/thumbs/processed/w1.webp.webp',
      profile: {
        body: 'full', acidity: 'medium', sweetness: 'dry', tannin: 'high',
        flavors: ['blackcurrant', 'cedar'], foodPairings: ['lamb'],
      },
    });
  });

  test('a wine with a sweetness style sends it in its documented shape, beside the label term and out of the name', () => {
    const styled = {
      ...WINE, _id: 'w2', name: 'Riesling Kabinett', labelSweetness: null,
      sweetnessStyle: { term: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false }, source: 'trade', url: 'https://merchant.example/kabinett' },
    };
    const s = inv({ bottles: [bottle({ wineDefinition: styled })] });
    expect(s.wines.w2).toMatchObject({
      displayName: 'Riesling Kabinett',
      labelSweetness: null,
      sweetnessStyle: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: 'https://merchant.example/kabinett' },
    });
  });

  test('a style whose term cannot be read is left out — never null, never the stored shape', () => {
    const dangling = { ...WINE, _id: 'w3', sweetnessStyle: { term: 'f'.repeat(24), source: 'trade', url: 'https://merchant.example/x' } };
    const s = inv({ bottles: [bottle({ wineDefinition: dangling })] });
    expect(s.wines.w3).not.toHaveProperty('sweetnessStyle');
    expect(JSON.stringify(s.wines.w3)).not.toMatch(/merchant.example/);
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

  test('a bottle that left (include=consumed): its status, how it was finished, no maturity, the same shape', () => {
    const [b] = inv({
      racks: [],
      bottles: [bottle({
        status: 'gifted', consumedAt: new Date('2026-10-30T19:00:00Z'), consumedRating: 4.5, consumedRatingScale: '5',
        consumedNote: '  To my sister  ', consumedReason: 'gifted',
      })],
    }).bottles;
    expect(b).toMatchObject({
      status: 'gifted', maturity: null, location: null,
      consumed: { at: '2026-10-30T19:00:00.000Z', rating: 4.5, ratingScale: '5', note: 'To my sister' },
      // The window is kept: it says whether it was opened in time.
      window: { drinkFrom: NOW_YEAR - 1, peakFrom: NOW_YEAR + 2, peakUntil: NOW_YEAR + 6, drinkTo: NOW_YEAR + 10 },
    });
    expect(Object.keys(b)).toEqual(Object.keys(inv().bottles[0]));
    // Nothing recorded → nulls; a scale only beside a rating.
    const [bare] = inv({ bottles: [bottle({ status: 'drank', consumedRatingScale: '5' })] }).bottles;
    expect(bare.consumed).toEqual({ at: null, rating: null, ratingScale: null, note: null });
    // Every status that left; anything else (a legacy row without one) is active.
    for (const status of ['drank', 'gifted', 'sold', 'other']) expect(inv({ bottles: [bottle({ status })] }).bottles[0].status).toBe(status);
    expect(inv({ bottles: [bottle({ status: undefined })] }).bottles[0]).toMatchObject({ status: 'active', consumed: null });
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
      sort: (s) => { record.sort = s; return q; },
      limit: (n) => { record.limit = n; return q; },
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

  test('include=consumed: the stock as always, then the bottles that left — their own capped query, newest finished first', async () => {
    const rec = { stock: {}, left: {} };
    Cellar.find.mockReturnValue(chain([OWN]));
    Bottle.find
      .mockReturnValueOnce(chain([bottle()], rec.stock))
      .mockReturnValueOnce(chain([bottle({ _id: 'b2', status: 'drank', consumedAt: new Date('2026-10-30T19:00:00Z') })], rec.left));
    Bottle.countDocuments.mockResolvedValue(1);
    Rack.find.mockReturnValue(chain([]));
    WineDefinition.find.mockReturnValue(chain([]));

    const s = await buildInventory(ME, { attachBottleImageUrls: jest.fn(async (bs) => bs), include: ['consumed'] });

    const [stockQ, leftQ] = Bottle.find.mock.calls.slice(-2).map((c) => c[0]);
    expect(stockQ.status.$nin).toEqual(expect.arrayContaining(['drank', 'gifted', 'sold', 'other', 'ordered']));
    expect(rec.stock.select).toBe(BOTTLE_SELECT);
    // On-order bottles stay out: the second query names exactly the statuses that left.
    expect(leftQ).toEqual({ cellar: { $in: ['c1'] }, status: { $in: ['drank', 'gifted', 'sold', 'other'] } });
    expect(rec.left.select).toBe(`${BOTTLE_SELECT} ${CONSUMED_SELECT}`);
    expect(rec.left.sort).toEqual({ consumedAt: -1, _id: -1 });
    expect(rec.left.limit).toBe(CONSUMED_LIMIT);
    expect(Bottle.countDocuments).toHaveBeenCalledWith(leftQ);
    expect(s.bottles.map((b) => [b.id, b.status])).toEqual([['b1', 'active'], ['b2', 'drank']]);
    expect(s.bottles[1].consumed).toMatchObject({ at: '2026-10-30T19:00:00.000Z' });
    expect(s).toMatchObject({ consumedTotal: 1, consumedTruncated: false });
    expect(BOTTLE_SELECT.split(' ')).not.toEqual(expect.arrayContaining(CONSUMED_SELECT.split(' ')));
    expect(CONSUMED_SELECT.split(' ').sort()).toEqual(['consumedAt', 'consumedNote', 'consumedRating', 'consumedRatingScale']);
  });

  test('a history past the cap: the newest CONSUMED_LIMIT, flagged as cut short; a bottle finished meanwhile is no cut', async () => {
    expect(CONSUMED_LIMIT).toBe(10000);
    const run = async (leftCount, total) => {
      Cellar.find.mockReturnValue(chain([OWN]));
      const left = Array.from({ length: leftCount }, (_, i) => ({ _id: `x${i}`, cellar: 'c1', status: 'drank', wineDefinition: null }));
      Bottle.find.mockReturnValueOnce(chain([])).mockReturnValueOnce(chain(left));
      Bottle.countDocuments.mockResolvedValue(total);
      Rack.find.mockReturnValue(chain([]));
      WineDefinition.find.mockReturnValue(chain([]));
      return buildInventory(ME, { attachBottleImageUrls: async (bs) => bs, include: ['consumed'] });
    };
    const capped = await run(CONSUMED_LIMIT, 12345);
    expect(capped.bottles).toHaveLength(CONSUMED_LIMIT);
    expect(capped).toMatchObject({ consumedTotal: 12345, consumedTruncated: true });
    // The count ran a moment after the list and saw one more: complete all the same.
    expect(await run(40, 41)).toMatchObject({ consumedTotal: 41, consumedTruncated: false });
  });

  test('without include, no count and no summary fields; no cellars with include → an honest zero', async () => {
    Cellar.find.mockReturnValue(chain([OWN]));
    Bottle.find.mockReturnValue(chain([bottle()]));
    Bottle.countDocuments.mockClear();
    Rack.find.mockReturnValue(chain([]));
    WineDefinition.find.mockReturnValue(chain([]));
    const s = await buildInventory(ME, { attachBottleImageUrls: async (bs) => bs });
    expect(Bottle.countDocuments).not.toHaveBeenCalled();
    expect(s).not.toHaveProperty('consumedTotal');
    expect(s).not.toHaveProperty('consumedTruncated');

    Cellar.find.mockReturnValue(chain([]));
    expect(await buildInventory(ME, { attachBottleImageUrls: jest.fn(), include: ['consumed'] }))
      .toMatchObject({ bottles: [], consumedTotal: 0, consumedTruncated: false });
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
      { path: 'labelSweetness', select: 'name band scale regulated -_id' },
      { path: 'sweetnessStyle.term', select: 'name band scale regulated' },
    ]);
    expect(wine.select.split(' ')).toEqual(expect.arrayContaining(['labelSweetness', 'sweetnessStyle']));
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
    // include=consumed answers another document, so another tag space.
    const all = await inventoryTag(ME, t, { include: ['consumed'] });
    expect(all).not.toBe(inv);
    expect(all).toBe(await snapshotTag(ME, t, { salt: 'inventory:1:consumed' }));
    expect(await inventoryTag(ME, t, { include: [] })).toBe(inv);
  });
});

describe('parseInclude', () => {
  test('nothing → none; a list, repeats and spaces fold to one sorted set', () => {
    expect(parseInclude(undefined)).toEqual({ include: [] });
    expect(parseInclude('')).toEqual({ include: [] });
    expect(parseInclude('consumed')).toEqual({ include: ['consumed'] });
    expect(parseInclude(' consumed , consumed')).toEqual({ include: ['consumed'] });
    expect(parseInclude(['consumed', 'consumed'])).toEqual({ include: ['consumed'] });
  });

  test('an unknown value is an error naming it (cut short), never ignored', () => {
    expect(parseInclude('consumed,ordered')).toEqual({ error: 'Unknown include value "ordered". Supported: consumed.' });
    expect(parseInclude('x'.repeat(100)).error).toBe(`Unknown include value "${'x'.repeat(40)}". Supported: consumed.`);
    // ?include[a]=b arrives as an object: not a value we know.
    expect(parseInclude({ a: 'b' }).error).toMatch(/^Unknown include value/);
  });
});
