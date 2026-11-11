/**
 * GET /api/bottles — what each query parameter does to the list.
 *
 * The list is built in two halves: a MongoDB query (the bottle's own fields,
 * and the wine's fields resolved to wine ids first), then work in memory for
 * what the database cannot do (text search, rating limits, maturity, and
 * sorting by name, maturity or a history bottle's rating). Pinned here: the
 * query each parameter produces, which half sorts and pages, and what the
 * in-memory half keeps.
 *
 * Models are mocked: `Bottle.find` records the filter and the chain it was
 * given and answers the same rows whatever the filter, so a test reads either
 * the recorded query or what the route did with the rows.
 */

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1', roles: ['user'] }; next(); },
  requireNonDemo: (req, res, next) => next(),
}));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }) }));
jest.mock('../services/bottleLot', () => ({ findLotSiblingIds: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({ checkRestockGap: jest.fn(), resolveRestockAlerts: jest.fn() }));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn(), getSnapshotForDate: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));
// A row's maturity is what the fixture says (`testMaturity`); the filter set,
// the match and the sort keys are the real ones.
jest.mock('../utils/maturityUtils', () => ({
  ...jest.requireActual('../utils/maturityUtils'),
  buildProfileMap: jest.fn().mockResolvedValue(new Map()),
  classifyMaturity: jest.fn((b) => b.testMaturity ?? null),
}));
jest.mock('./cellars', () => ({ attachBottleImageUrls: jest.fn(async (bottles) => bottles) }));

jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({}));
jest.mock('../models/Country', () => ({ find: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/BottleImage', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn() }));

const express = require('express');
const http = require('http');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const { attachBottleImageUrls } = require('./cellars');
const { buildProfileMap } = require('../utils/maturityUtils');
const { CONSUMED_STATUSES, NOT_IN_CELLAR_STATUSES, WINE_POPULATE_LIST } = require('../config/constants');
const bottlesRouter = require('./bottles');

const COUNTRY_ID = '64b000000000000000000001';
const COUNTRY_ID_2 = '64b000000000000000000002';
const REGION_ID = '64b000000000000000000011';
const GRAPE_ID = '64b000000000000000000021';
const WINE_IDS = ['64b0000000000000000000a1', '64b0000000000000000000a2'];

const wine = (name, over = {}) => ({
  _id: `wine-${name}`, name, producer: over.producer || 'A producer', type: over.type || 'red',
  appellation: over.appellation,
  country: over.country ? { _id: COUNTRY_ID, name: over.country } : undefined,
  region: over.region ? { _id: REGION_ID, name: over.region } : undefined,
  grapes: (over.grapes || []).map((g, i) => ({ _id: `grape-${i}`, name: g })),
});
// Four bottles: three in the cellar, one drunk and without a wine (a pending
// wine request from an import). Ratings are in stars; on the 0-100 scale the
// filters use, 3 stars is 50, 4 stars 75 and 5 stars 100.
const ROWS = [
  {
    _id: 'margaux', vintage: '2015', status: 'active', createdAt: '2026-01-03T00:00:00.000Z',
    rating: 4, ratingScale: '5', notes: 'A birthday gift', location: 'Garage', testMaturity: 'peak',
    wineDefinition: wine('Château Margaux', { producer: 'Château Margaux', country: 'France', region: 'Bordeaux', appellation: 'Margaux', grapes: ['Cabernet Sauvignon', 'Merlot'] }),
  },
  {
    _id: 'barolo', vintage: '2019', status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
    rating: 3, ratingScale: '5', testMaturity: 'not-ready',
    wineDefinition: wine('Barolo Cannubi', { producer: 'Marchesi di Barolo', country: 'Italy', region: 'Piedmont', grapes: ['Nebbiolo'] }),
  },
  {
    _id: 'ayala', vintage: 'NV', status: 'active', createdAt: '2026-01-02T00:00:00.000Z', testMaturity: null,
    wineDefinition: wine('Ayala Brut Majeur', { type: 'sparkling', country: 'France', region: 'Champagne' }),
  },
  {
    _id: 'drunk', vintage: '2020', status: 'drank', createdAt: '2026-01-04T00:00:00.000Z',
    rating: 2, ratingScale: '5', consumedRating: 5, consumedRatingScale: '5', testMaturity: 'late',
    wineDefinition: null,
  },
];

let finds; // every Bottle.find of the request: { filter, populate, sort, skip, limit }
let wineFinds; // every WineDefinition.find filter
let taxonomyFinds; // { Country: [filters], Region: [...], Grape: [...] }
let taxonomyIds; // what a name look-up answers, per model
let wineIds; // what the wine pre-query answers

beforeEach(() => {
  finds = []; wineFinds = []; taxonomyFinds = { Country: [], Region: [], Grape: [] };
  taxonomyIds = { Country: [COUNTRY_ID_2], Region: [REGION_ID], Grape: [GRAPE_ID] };
  wineIds = WINE_IDS;
  Cellar.find.mockReset().mockReturnValue({ distinct: async () => ['cellar-1'] });
  Bottle.find.mockReset().mockImplementation((filter) => {
    const rec = { filter, populate: null, sort: null, skip: null, limit: null };
    finds.push(rec);
    const chain = {
      populate: (p) => { rec.populate = p; return chain; },
      sort: (s) => { rec.sort = s; return chain; },
      skip: (n) => { rec.skip = n; return chain; },
      limit: (n) => { rec.limit = n; return chain; },
      lean: async () => ROWS.map((r) => ({ ...r })),
    };
    return chain;
  });
  Bottle.countDocuments.mockReset().mockResolvedValue(42);
  WineDefinition.find.mockReset().mockImplementation((filter) => { wineFinds.push(filter); return { distinct: async () => wineIds }; });
  for (const [name, Model] of [['Country', Country], ['Region', Region], ['Grape', Grape]]) {
    Model.find.mockReset().mockImplementation((filter) => { taxonomyFinds[name].push(filter); return { distinct: async () => taxonomyIds[name] }; });
  }
  attachBottleImageUrls.mockReset().mockImplementation(async (bottles) => bottles);
  buildProfileMap.mockClear();
});

function get(url) {
  const app = express();
  app.use('/api/bottles', bottlesRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({ port: server.address().port, path: url, method: 'GET' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}
const list = async (query = '') => {
  const res = await get('/api/bottles' + (query ? '?' + query : ''));
  expect(res.status).toBe(200);
  return res.body.bottles;
};
const ids = (bottles) => bottles.items.map((b) => b._id);
const EMPTY = { count: 0, total: 0, limit: 30, skip: 0, items: [] };
const ACTIVE = { $nin: NOT_IN_CELLAR_STATUSES };

describe('GET /api/bottles: the scope', () => {
  test('with no filter: the bottles in the cellars the user owns, newest first, 30 a page', async () => {
    const bottles = await list();
    expect(Cellar.find).toHaveBeenCalledWith({ user: 'user-1', deletedAt: null });
    expect(finds).toHaveLength(1);
    expect(finds[0]).toEqual({
      filter: { user: 'user-1', cellar: { $in: ['cellar-1'] }, status: ACTIVE },
      populate: WINE_POPULATE_LIST, sort: { createdAt: -1 }, skip: 0, limit: 30,
    });
    expect(Bottle.countDocuments).toHaveBeenCalledWith(finds[0].filter);
    expect(bottles).toMatchObject({ count: 4, total: 42, limit: 30, skip: 0 });
  });

  test('a user who owns no cellar gets an empty page and no bottle is read', async () => {
    Cellar.find.mockReturnValue({ distinct: async () => [] });
    expect(await list('limit=5&offset=10')).toEqual({ ...EMPTY, limit: 5, skip: 10 });
    expect(Bottle.find).not.toHaveBeenCalled();
  });

  test.each([
    ['active', ACTIVE],
    ['ordered', 'ordered'],
    ['drank', 'drank'],
    ['gifted', 'gifted'],
    ['sold', 'sold'],
    ['other', 'other'],
    ['consumed', { $in: CONSUMED_STATUSES }],
    ['no-such-status', ACTIVE],
  ])('status=%s', async (status, expected) => {
    await list('status=' + status);
    expect(finds[0].filter.status).toEqual(expected);
  });

  test('status=all puts no limit on the status', async () => {
    await list('status=all');
    expect(finds[0].filter).toEqual({ user: 'user-1', cellar: { $in: ['cellar-1'] } });
  });
});

describe('GET /api/bottles: the bottle\'s own fields', () => {
  test('vintage: one value is matched exactly, several are any-of, blanks are dropped', async () => {
    await list('vintage=2019');
    await list('vintage=2019,%20NV%20,,2020');
    expect(finds[0].filter.vintage).toBe('2019');
    expect(finds[1].filter.vintage).toEqual({ $in: ['2019', 'NV', '2020'] });
  });

  test('bottleSize is matched exactly', async () => {
    await list('bottleSize=1500ml');
    expect(finds[0].filter.bottleSize).toBe('1500ml');
  });

  test('purchaseYear and consumedYear select the calendar year', async () => {
    await list('purchaseYear=2024&consumedYear=2025');
    expect(finds[0].filter.purchaseDate).toEqual({ $gte: new Date(2024, 0, 1), $lt: new Date(2025, 0, 1) });
    expect(finds[0].filter.consumedAt).toEqual({ $gte: new Date(2025, 0, 1), $lt: new Date(2026, 0, 1) });
  });

  test.each(['1899', '2201', 'last-year'])('a year that cannot be one (%s) is ignored', async (year) => {
    await list(`purchaseYear=${year}&consumedYear=${year}`);
    expect(finds[0].filter).toEqual({ user: 'user-1', cellar: { $in: ['cellar-1'] }, status: ACTIVE });
  });

  test('a parameter that is not one plain value is ignored: an operator object or a repeated key', async () => {
    await list('bottleSize[$ne]=1&vintage=2019&vintage=2020&status[$gt]=&search[]=x');
    expect(finds[0].filter).toEqual({ user: 'user-1', cellar: { $in: ['cellar-1'] }, status: ACTIVE });
    // ...and the list is the plain first page, read and paged by the database.
    expect(finds[0]).toMatchObject({ sort: { createdAt: -1 }, skip: 0, limit: 30 });
  });
});

describe('GET /api/bottles: the wine\'s fields, resolved to wine ids first', () => {
  test('country by id: the wines of that country, then the bottles of those wines', async () => {
    await list('country=' + COUNTRY_ID);
    expect(Country.find).not.toHaveBeenCalled();
    expect(wineFinds).toEqual([{ country: COUNTRY_ID }]);
    expect(finds[0].filter.wineDefinition).toEqual({ $in: WINE_IDS });
  });

  test('country by name is looked up; ids and names can be mixed', async () => {
    await list(`country=${COUNTRY_ID},Italy,%20Spain`);
    expect(taxonomyFinds.Country).toEqual([{ name: { $in: ['Italy', 'Spain'] } }]);
    expect(wineFinds).toEqual([{ country: { $in: [COUNTRY_ID, COUNTRY_ID_2] } }]);
  });

  test('region and grapes work the same way', async () => {
    await list(`region=Piedmont&grapes=${GRAPE_ID},Nebbiolo`);
    expect(taxonomyFinds.Region).toEqual([{ name: { $in: ['Piedmont'] } }]);
    expect(taxonomyFinds.Grape).toEqual([{ name: { $in: ['Nebbiolo'] } }]);
    expect(wineFinds).toEqual([{ region: REGION_ID, grapes: { $in: [GRAPE_ID, GRAPE_ID] } }]);
  });

  test.each([['country', 'Country'], ['region', 'Region'], ['grapes', 'Grape']])('a %s name that does not exist empties the list without reading a wine or a bottle', async (param, model) => {
    taxonomyIds[model] = [];
    expect(await list(`${param}=Atlantis`)).toEqual(EMPTY);
    expect(WineDefinition.find).not.toHaveBeenCalled();
    expect(Bottle.find).not.toHaveBeenCalled();
  });

  test('type: one, or several', async () => {
    await list('type=red');
    await list('type=red,%20white');
    expect(wineFinds).toEqual([{ type: 'red' }, { type: { $in: ['red', 'white'] } }]);
  });

  test('type=unknown is the bottles without a wine: no wine is looked up', async () => {
    await list('type=unknown');
    expect(WineDefinition.find).not.toHaveBeenCalled();
    expect(finds[0].filter.wineDefinition).toBeNull();
  });

  test('type=red,unknown is the red wines and the bottles without a wine', async () => {
    await list('type=red,unknown');
    expect(wineFinds).toEqual([{ type: 'red' }]);
    expect(finds[0].filter.wineDefinition).toEqual({ $in: [...WINE_IDS, null] });
  });

  test('type=red,unknown still lists the bottles without a wine when no red wine exists', async () => {
    wineIds = [];
    await list('type=red,unknown');
    expect(finds[0].filter.wineDefinition).toEqual({ $in: [null] });
  });

  test('producer is the whole name, whatever its case, with its punctuation taken literally', async () => {
    await list('producer=' + encodeURIComponent('Dr. Loosen (Mosel)'));
    const re = wineFinds[0].producer;
    expect(re).toBeInstanceOf(RegExp);
    expect(re.flags).toBe('i');
    expect(re.test('dr. loosen (mosel)')).toBe(true);
    expect(re.test('Dr. Loosen (Mosel) Estate')).toBe(false);
    expect(re.test('DrX Loosen (Mosel)')).toBe(false);
  });

  test('wine filters that match no wine empty the list without reading a bottle', async () => {
    wineIds = [];
    expect(await list('type=orange&limit=7')).toEqual({ ...EMPTY, limit: 7 });
    expect(Bottle.find).not.toHaveBeenCalled();
  });

  test('the wine filters are one query together', async () => {
    await list(`country=${COUNTRY_ID}&type=red&producer=Roagna`);
    expect(wineFinds).toHaveLength(1);
    expect(Object.keys(wineFinds[0]).sort()).toEqual(['country', 'producer', 'type']);
  });
});

describe('GET /api/bottles: sorting and paging', () => {
  test.each([
    ['createdAt', { createdAt: 1 }],
    ['-vintage', { vintage: -1 }],
    ['price', { price: 1 }],
    ['-rating', { rating: -1 }],
  ])('sort=%s is sorted, skipped and limited by the database, and the total is counted there', async (sort, expected) => {
    const bottles = await list(`sort=${sort}&limit=10&offset=20`);
    expect(finds[0]).toMatchObject({ sort: expected, skip: 20, limit: 10 });
    expect(Bottle.countDocuments).toHaveBeenCalledTimes(1);
    expect(bottles).toMatchObject({ total: 42, limit: 10, skip: 20 });
    // the rows come back as the database gave them
    expect(ids(bottles)).toEqual(['margaux', 'barolo', 'ayala', 'drunk']);
  });

  test('limit is at most 200; page counts from 1; skip is another word for offset', async () => {
    await list('limit=5000');
    await list('limit=10&page=3');
    await list('limit=10&skip=40');
    expect(finds.map((f) => [f.skip, f.limit])).toEqual([[0, 200], [20, 10], [40, 10]]);
  });

  test('a repeated limit reads as its first value', async () => {
    const bottles = await list('limit=10&limit=20');
    expect(finds[0].limit).toBe(10);
    expect(bottles.limit).toBe(10);
  });

  test('sort=name is done in memory: up to 10,000 newest rows are read, sorted, then paged', async () => {
    const bottles = await list('sort=name&limit=2&offset=1');
    expect(finds[0]).toMatchObject({ sort: { createdAt: -1 }, skip: null, limit: 10000 });
    expect(Bottle.countDocuments).not.toHaveBeenCalled();
    // all four by name: (no wine), Ayala, Barolo, Château; the page is the 2nd and 3rd
    expect(ids(bottles)).toEqual(['ayala', 'barolo']);
    expect(bottles).toMatchObject({ count: 2, total: 4, limit: 2, skip: 1 });
  });

  test('sort=-name is the reverse', async () => {
    expect(ids(await list('sort=-name'))).toEqual(['margaux', 'barolo', 'ayala', 'drunk']);
  });

  test('a list that holds history sorts by the rating each bottle counts with, unrated last from high to low', async () => {
    const bottles = await list('status=all&sort=-rating');
    expect(finds[0]).toMatchObject({ sort: { createdAt: -1 }, skip: null, limit: 10000 });
    // the drunk bottle counts with the 5 stars given when drinking, not the 2 on the bottle
    expect(ids(bottles)).toEqual(['drunk', 'margaux', 'barolo', 'ayala']);
    expect(ids(await list('status=consumed&sort=rating'))).toEqual(['ayala', 'barolo', 'margaux', 'drunk']);
  });

  test('a sort the list does not know falls back to the date added, in the direction asked', async () => {
    expect(ids(await list('sort=colour'))).toEqual(['barolo', 'ayala', 'margaux', 'drunk']);
    expect(ids(await list('sort=-colour'))).toEqual(['drunk', 'margaux', 'ayala', 'barolo']);
    expect(finds[0]).toMatchObject({ sort: { createdAt: -1 }, limit: 10000 });
  });

  test('sort=maturity orders by stage, the soonest to drink first, and each row carries its stage', async () => {
    const bottles = await list('sort=maturity');
    expect(buildProfileMap).toHaveBeenCalledTimes(1);
    expect(ids(bottles)).toEqual(['drunk', 'margaux', 'barolo', 'ayala']);
    expect(bottles.items.map((b) => b.maturityStatus)).toEqual(['late', 'peak', 'not-ready', null]);
    expect(ids(await list('sort=-maturity'))).toEqual(['ayala', 'barolo', 'margaux', 'drunk']);
  });
});

describe('GET /api/bottles: what is done in memory', () => {
  test.each([
    ['chateau', ['margaux']], // accents do not matter
    ['MARGAUX%20merlot', ['margaux']], // every word, in any field
    ['garage', ['margaux']], // the bottle's location
    ['birthday', ['margaux']], // its notes
    ['marchesi', ['barolo']], // the producer
    ['nebbiolo', ['barolo']], // a grape
    ['france', ['margaux', 'ayala']], // the country
    ['champagne', ['ayala']], // the region
    ['sparkling', ['ayala']], // the type
    ['margaux%20nebbiolo', []], // every word must be found
  ])('search=%s', async (search, expected) => {
    const bottles = await list('search=' + search);
    expect(ids(bottles)).toEqual(expected);
    expect(bottles.total).toBe(expected.length);
  });

  test('a search reads up to 10,000 rows in the order asked and pages what matched', async () => {
    const bottles = await list('search=france&sort=-vintage&limit=1&offset=1');
    expect(finds[0]).toMatchObject({ sort: { vintage: -1 }, skip: null, limit: 10000 });
    expect(Bottle.countDocuments).not.toHaveBeenCalled();
    expect(bottles).toMatchObject({ count: 1, total: 2, limit: 1, skip: 1 });
    expect(ids(bottles)).toEqual(['ayala']);
  });

  test('minRating and maxRating are inclusive limits on the 0-100 rating; an unrated bottle never matches', async () => {
    expect(ids(await list('minRating=75'))).toEqual(['margaux', 'drunk']);
    expect(ids(await list('maxRating=50'))).toEqual(['barolo']);
    expect(ids(await list('minRating=60&maxRating=80'))).toEqual(['margaux']);
    // the drunk bottle counts with the 5 stars given when drinking, not the 2 on the bottle
    expect(ids(await list('minRating=76'))).toEqual(['drunk']);
    expect(ids(await list('maxRating=30'))).toEqual([]);
  });

  test('a rating limit that is not a number is ignored', async () => {
    expect(ids(await list('minRating=high'))).toEqual(['margaux', 'barolo', 'ayala', 'drunk']);
  });

  test('ratingBand is one of the bands of the statistics; another word is ignored', async () => {
    expect(ids(await list('ratingBand=61-80'))).toEqual(['margaux']);
    expect(ids(await list('ratingBand=41-60'))).toEqual(['barolo']);
    expect(ids(await list('ratingBand=81-100'))).toEqual(['drunk']);
    expect(ids(await list('ratingBand=excellent'))).toEqual(['margaux', 'barolo', 'ayala', 'drunk']);
  });

  test('maturity keeps the stages asked for, and marks every row with its stage', async () => {
    const bottles = await list('maturity=peak,late');
    expect(ids(bottles)).toEqual(['margaux', 'drunk']);
    expect(bottles.items.map((b) => b.maturityStatus)).toEqual(['peak', 'late']);
    expect(bottles.total).toBe(2);
    expect(finds[0]).toMatchObject({ skip: null, limit: 10000 });
  });

  test('maturity=none is the bottles with no drink window', async () => {
    expect(ids(await list('maturity=none'))).toEqual(['ayala']);
  });

  test('a maturity value that names no stage matches nothing', async () => {
    expect(await list('maturity=ripe')).toMatchObject({ count: 0, total: 0, items: [] });
  });

  test('without a maturity filter or sort no drink window is read and no row carries a stage', async () => {
    const bottles = await list('search=france');
    expect(buildProfileMap).not.toHaveBeenCalled();
    expect(bottles.items.every((b) => !('maturityStatus' in b))).toBe(true);
  });
});

describe('GET /api/bottles: the answer', () => {
  test('each grape of a wine gains a display name; a bottle without a wine stays as it is', async () => {
    const bottles = await list();
    const margaux = bottles.items.find((b) => b._id === 'margaux');
    expect(margaux.wineDefinition.grapes).toEqual([
      { _id: 'grape-0', name: 'Cabernet Sauvignon', displayName: 'Cabernet Sauvignon' },
      { _id: 'grape-1', name: 'Merlot', displayName: 'Merlot' },
    ]);
    expect(bottles.items.find((b) => b._id === 'drunk').wineDefinition).toBeNull();
  });

  test('the page is given its photos for the user who asked', async () => {
    await list('limit=2&sort=name');
    expect(attachBottleImageUrls).toHaveBeenCalledTimes(1);
    const [rows, userId] = attachBottleImageUrls.mock.calls[0];
    expect(rows.map((b) => b._id)).toEqual(['drunk', 'ayala']); // the page, not the 10,000
    expect(userId).toBe('user-1');
  });

  test('a failed photo look-up does not fail the list', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    attachBottleImageUrls.mockRejectedValue(new Error('photos are down'));
    expect((await list()).count).toBe(4);
    quiet.mockRestore();
  });

  test('a failure while reading the bottles is a 500 with the list\'s own message', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    Bottle.find.mockImplementation(() => { throw new Error('the database is down'); });
    const res = await get('/api/bottles');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load bottles' });
    quiet.mockRestore();
  });
});
