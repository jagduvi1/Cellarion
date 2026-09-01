/**
 * Editing a taxonomy display name in another language.
 *
 * A French owner filed a correction proposal asking that "Rhône Valley" read
 * "Vallée du Rhône" (6a959b9d, 2026-09-01, reason: "En Français svp"). It had
 * to be rejected as filed — a region's `name` is stored once and shared, so a
 * rename would have moved all 298 wines on it into a French-named region for
 * every user in every language. This endpoint is the thing he actually wanted:
 * a translation beside the canonical name, not instead of it.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false), fullSync: jest.fn(), fullSyncBottles: jest.fn(),
  indexWine: jest.fn(), removeWine: jest.fn(), bulkIndexWines: jest.fn(),
  bulkIndexBottles: jest.fn(), waitForTasks: jest.fn(),
}));
const mockLogAudit = jest.fn();
jest.mock('../../services/audit', () => ({ logAudit: (...a) => mockLogAudit(...a) }));
jest.mock('../../services/taxonomyMerge', () => ({ mergeGrapes: jest.fn(), mergeRegions: jest.fn(), mergeCountries: jest.fn() }));
jest.mock('../../services/taxonomyReview', () => ({
  listUnmatchedAppellations: jest.fn(), appellationRefsError: jest.fn(),
  dismissUnmatchedAppellation: jest.fn(), restoreDismissedAppellation: jest.fn(),
  listDismissedAppellations: jest.fn(),
}));
jest.mock('../../services/bottleSizeMaintenance', () => ({ distinctSizes: jest.fn(), normalizeAll: jest.fn(), remap: jest.fn() }));
const mockClearCache = jest.fn();
jest.mock('../taxonomy', () => ({ clearTaxonomyListCache: (...a) => mockClearCache(...a) }));

const mockRegionFindById = jest.fn();
jest.mock('../../models/Region', () => ({
  find: jest.fn(), findById: (...a) => mockRegionFindById(...a), countDocuments: jest.fn(), aggregate: jest.fn(),
}));
const mockCountryFindById = jest.fn();
jest.mock('../../models/Country', () => ({
  find: jest.fn(), findById: (...a) => mockCountryFindById(...a), exists: jest.fn(),
}));
jest.mock('../../models/Grape', () => ({ find: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock('../../models/Appellation', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ aggregate: jest.fn(), countDocuments: jest.fn(), find: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const router = require('./taxonomy');

const RHONE = '64b000000000000000000aa1';
let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const token = jwt.sign({ id: '64b000000000000000000001', roles: ['admin'] }, 'test-secret');
const put = (path, body) => fetch(`${baseUrl}/api/admin/taxonomy/${path}`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
// An unmatched path falls through to Express's own HTML 404, so the body is
// only parsed when the response actually claims to be JSON.
}).then(async (r) => ({
  status: r.status,
  body: r.headers.get('content-type')?.includes('application/json') ? await r.json() : null,
}));

/** A saveable stand-in for the Mongoose doc the route mutates. */
const docStub = (over = {}) => ({
  _id: RHONE, name: 'Rhône Valley', translations: undefined, save: jest.fn().mockResolvedValue(true), ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('PUT /:kind/:id/translations', () => {
  test('stores the French name the owner asked for, leaving the canonical name alone', async () => {
    const doc = docStub();
    mockRegionFindById.mockResolvedValue(doc);
    const res = await put(`regions/${RHONE}/translations`, { translations: { fr: 'Vallée du Rhône' } });
    expect(res.status).toBe(200);
    expect(res.body.translations).toEqual({ fr: 'Vallée du Rhône' });
    expect(doc.name).toBe('Rhône Valley');           // untouched — this is the whole point
    expect(doc.translations).toEqual({ fr: 'Vallée du Rhône' });
    expect(doc.save).toHaveBeenCalled();
  });

  test('countries work the same way — his own file said "Allemagne" on the way in', async () => {
    const doc = docStub({ name: 'Germany' });
    mockCountryFindById.mockResolvedValue(doc);
    const res = await put(`countries/${RHONE}/translations`, { translations: { fr: 'Allemagne', de: 'Deutschland' } });
    expect(res.status).toBe(200);
    expect(doc.translations).toEqual({ fr: 'Allemagne', de: 'Deutschland' });
  });

  test('a full replacement REMOVES a language left out of the body', async () => {
    // The only shape in which an editor can delete a wrong translation. A
    // merge-only endpoint would leave one stuck for good.
    const doc = docStub({ translations: new Map([['fr', 'Vallée du Rhône'], ['de', 'Wrong']]) });
    mockRegionFindById.mockResolvedValue(doc);
    const res = await put(`regions/${RHONE}/translations`, { translations: { fr: 'Vallée du Rhône' } });
    expect(res.status).toBe(200);
    expect(doc.translations).toEqual({ fr: 'Vallée du Rhône' });
  });

  test('clearing every language sets undefined, not an empty Map', async () => {
    // The field's default is undefined; an empty Map would leave every
    // untranslated document carrying one.
    const doc = docStub({ translations: new Map([['fr', 'Vallée du Rhône']]) });
    mockRegionFindById.mockResolvedValue(doc);
    const res = await put(`regions/${RHONE}/translations`, { translations: {} });
    expect(res.status).toBe(200);
    expect(doc.translations).toBeUndefined();
  });

  test('the public list cache is cleared, or the old name serves for the full TTL', async () => {
    mockRegionFindById.mockResolvedValue(docStub());
    await put(`regions/${RHONE}/translations`, { translations: { fr: 'Vallée du Rhône' } });
    expect(mockClearCache).toHaveBeenCalled();
  });

  test('the change is audited with both the before and the after', async () => {
    const doc = docStub({ translations: new Map([['fr', 'Ancien']]) });
    mockRegionFindById.mockResolvedValue(doc);
    await put(`regions/${RHONE}/translations`, { translations: { fr: 'Vallée du Rhône' } });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), 'taxonomy.regions.translations',
      { type: 'Region', id: RHONE },
      { name: 'Rhône Valley', before: { fr: 'Ancien' }, after: { fr: 'Vallée du Rhône' } },
    );
  });

  test.each([
    [{ en: 'The Rhone' }, 'English is the canonical name and cannot be a translation'],
    [{ 'not a language': 'x' }, '"not a language" is not a language code'],
    [{ fr: 42 }, 'translation for "fr" must be a string'],
  ])('rejects %p with 400, before reading anything', async (translations, error) => {
    mockRegionFindById.mockResolvedValue(docStub());
    const res = await put(`regions/${RHONE}/translations`, { translations });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(mockRegionFindById).not.toHaveBeenCalled();
  });

  test('a malformed id is a 400 and an unknown one a 404', async () => {
    expect((await put('regions/not-an-id/translations', { translations: { fr: 'x' } })).status).toBe(400);
    mockRegionFindById.mockResolvedValue(null);
    expect((await put(`regions/${RHONE}/translations`, { translations: { fr: 'x' } })).status).toBe(404);
  });

  test('grapes and appellations are NOT translatable — the route does not exist for them', async () => {
    // Deliberate: a protected designation is a legal name (Côte-Rôtie is
    // Côte-Rôtie everywhere), and grape variation is regional rather than
    // linguistic — models/Grape already carries `regionalNames` for that.
    expect((await put(`grapes/${RHONE}/translations`, { translations: { fr: 'x' } })).status).toBe(404);
    expect((await put(`appellations/${RHONE}/translations`, { translations: { fr: 'x' } })).status).toBe(404);
  });
});
