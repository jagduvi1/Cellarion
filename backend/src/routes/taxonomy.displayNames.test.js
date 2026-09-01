/**
 * GET /api/taxonomy/display-names — the map the client localises against.
 *
 * Taxonomy names are rendered in about thirty places, and most of them never
 * call a taxonomy route: they receive a populated `region` on a wine or a
 * bottle. Serving one small map covers all of them at once and leaves every
 * existing query, projection and cache untouched — which is why this is a
 * separate endpoint rather than an extra field bolted onto the others.
 */

jest.mock('../models/WineDefinition', () => ({ aggregate: jest.fn(), countDocuments: jest.fn(), find: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn(), findOne: jest.fn() }));

const mockCountryFind = jest.fn();
jest.mock('../models/Country', () => ({ find: (...a) => mockCountryFind(...a), findOne: jest.fn() }));
const mockRegionFind = jest.fn();
jest.mock('../models/Region', () => ({ find: (...a) => mockRegionFind(...a), findOne: jest.fn() }));

const express = require('express');
const http = require('http');
const router = require('./taxonomy');

const chain = (rows) => ({ select: () => chain(rows), sort: () => chain(rows), lean: async () => rows });

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const get = (qs) => fetch(`${baseUrl}/api/taxonomy/display-names${qs}`)
  .then(async (r) => ({ status: r.status, cacheControl: r.headers.get('cache-control'), body: await r.json() }));

const RHONE = '64b000000000000000000aa1';
const GERMANY = '64b000000000000000000bb2';

beforeEach(() => {
  jest.clearAllMocks();
  // The route's cache lives in module scope and outlives a single test, so an
  // earlier test's answer would silently satisfy a later one — which is how
  // two of these first passed against stale data rather than the new stubs.
  router.clearTaxonomyListCache();
  mockRegionFind.mockReturnValue(chain([
    { _id: RHONE, name: 'Rhône Valley', translations: { fr: 'Vallée du Rhône', de: 'Rhônetal' } },
  ]));
  mockCountryFind.mockReturnValue(chain([
    { _id: GERMANY, name: 'Germany', translations: { fr: 'Allemagne', de: 'Deutschland' } },
  ]));
});

describe('display-names', () => {
  test('returns the French names keyed by both id and canonical name', async () => {
    const res = await get('?lang=fr');
    expect(res.status).toBe(200);
    expect(res.body.lang).toBe('fr');
    expect(res.body.byId).toEqual({ [RHONE]: 'Vallée du Rhône', [GERMANY]: 'Allemagne' });
    // byName catches the denormalised places that hold only the canonical string.
    expect(res.body.byName).toEqual({ 'Rhône Valley': 'Vallée du Rhône', Germany: 'Allemagne' });
    expect(res.body.total).toBe(2);
  });

  test('a regional variant resolves to the base language', async () => {
    expect((await get('?lang=fr-CA')).body.byName).toEqual({
      'Rhône Valley': 'Vallée du Rhône', Germany: 'Allemagne',
    });
  });

  test('English is empty — the canonical name already IS the English name', async () => {
    const res = await get('?lang=en');
    expect(res.body).toEqual({ lang: 'en', byId: {}, byName: {}, total: 0 });
    // and it must not have gone to the database to discover that
    expect(mockRegionFind).not.toHaveBeenCalled();
    expect(mockCountryFind).not.toHaveBeenCalled();
  });

  test.each([['', 'no lang at all'], ['?lang=', 'an empty lang'], ['?lang=zzzz', 'nonsense']])(
    '%p yields empty maps without a query (%s)', async (qs) => {
      const res = await get(qs);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(mockRegionFind).not.toHaveBeenCalled();
    },
  );

  test('only documents actually translated into this language are queried', async () => {
    await get('?lang=sv');
    // The dotted filter is what keeps the payload small — without it every
    // region in the registry would be read to find the handful translated.
    expect(mockRegionFind).toHaveBeenCalledWith({ 'translations.sv': { $exists: true, $ne: '' } });
    expect(mockCountryFind).toHaveBeenCalledWith({ 'translations.sv': { $exists: true, $ne: '' } });
  });

  test('a row whose translation equals its canonical name is left out', async () => {
    // Nothing to override, so it is dead weight in every client's map.
    mockRegionFind.mockReturnValue(chain([
      { _id: RHONE, name: 'Mosel', translations: { de: 'Mosel' } },
    ]));
    mockCountryFind.mockReturnValue(chain([]));
    const res = await get('?lang=de');
    expect(res.body.byId).toEqual({});
    expect(res.body.total).toBe(0);
  });

  test('a blank or missing translation is skipped rather than blanking the name', async () => {
    mockRegionFind.mockReturnValue(chain([
      { _id: RHONE, name: 'Rhône Valley', translations: { fr: '   ' } },
      { _id: GERMANY, name: 'Alsace', translations: {} },
    ]));
    mockCountryFind.mockReturnValue(chain([]));
    expect((await get('?lang=fr')).body.byId).toEqual({});
  });

  test('answers are cached and publicly cacheable', async () => {
    const first = await get('?lang=de');
    expect(first.cacheControl).toContain('max-age=3600');
    expect(mockRegionFind).toHaveBeenCalledTimes(1);
    await get('?lang=de');
    expect(mockRegionFind).toHaveBeenCalledTimes(1);   // served from the cache
  });
});
