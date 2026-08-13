/**
 * PUT /api/admin/wine-reports/:id/resolve with applySuggestion (strategy
 * 2026-07-29 R7). Pins: the structured correction is applied to the wine
 * through .save() (hooks) with normalizedKey recomputed; a unique-key
 * collision surfaces as a 409 merge-hint, not a crash; resolve without apply
 * never touches the wine; a suggestion-less report refuses apply.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineReport', () => ({ findById: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined), bulkIndexBottles: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineReport = require('../../models/WineReport');
const WineDefinition = require('../../models/WineDefinition');
const searchService = require('../../services/search');
const { logAudit } = require('../../services/audit');
const { generateWineKey } = require('../../utils/normalize');
const router = require('./wineReports');

const ADMIN_ID = '64b000000000000000000001';
const REPORT_ID = '64b0000000000000000000d1';
const WINE_ID = '64b0000000000000000000c1';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wine-reports', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const resolve = (body) => fetch(`${baseUrl}/api/admin/wine-reports/${REPORT_ID}/resolve`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

const report = (over = {}) => ({
  _id: REPORT_ID, status: 'pending', user: 'u1', wineDefinition: WINE_ID,
  suggestedField: 'producer', suggestedValue: 'Cave de Ribeauvillé',
  save: jest.fn().mockResolvedValue(undefined),
  populate: jest.fn().mockResolvedValue(undefined),
  ...over,
});

const wine = (over = {}) => ({
  _id: WINE_ID, name: 'Sylvaner', producer: 'Cave de Ribeauville', appellation: 'Alsace',
  normalizedKey: 'stale', save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('resolve with applySuggestion', () => {
  test('a NAME suggestion is canonicalized, not raw-assigned (audit R7-#1)', async () => {
    // Trailing vintage + embedded producer — both defect classes the write
    // pipeline strips must be stripped here too.
    const r = report({ suggestedField: 'name', suggestedValue: 'Cave de Ribeauville Sylvaner  Grand 2022' });
    const w = wine();
    WineReport.findById.mockResolvedValue(r);
    WineDefinition.findById.mockResolvedValue(w);
    const res = await resolve({ applySuggestion: true });
    expect(res.status).toBe(200);
    expect(w.name).not.toMatch(/2022/);   // trailing vintage stripped
    expect(w.name).not.toMatch(/ {2}/);   // internal whitespace collapsed
    expect(w.name).toMatch(/Sylvaner/);
  });

  test('applies the field, recomputes normalizedKey, saves, reindexes, audits both actions', async () => {
    const r = report();
    const w = wine();
    WineReport.findById.mockResolvedValue(r);
    WineDefinition.findById.mockResolvedValue(w);

    const res = await resolve({ applySuggestion: true, response: 'confirmed on producer site' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(w.producer).toBe('Cave de Ribeauvillé');
    expect(w.normalizedKey).toBe(generateWineKey('Sylvaner', 'Cave de Ribeauvillé', 'Alsace'));
    expect(w.save).toHaveBeenCalled();
    expect(searchService.indexWine).toHaveBeenCalledWith(WINE_ID);
    expect(body.applied).toEqual({ field: 'producer', from: 'Cave de Ribeauville', to: 'Cave de Ribeauvillé' });
    expect(r.status).toBe('resolved');
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.wine.update',
      expect.anything(), expect.objectContaining({ via: 'wine-report' }));
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'wine.report.resolved',
      expect.anything(), expect.anything());
  });

  test('a type suggestion does NOT touch normalizedKey (type is not identity)', async () => {
    const r = report({ suggestedField: 'type', suggestedValue: 'white' });
    const w = wine();
    WineReport.findById.mockResolvedValue(r);
    WineDefinition.findById.mockResolvedValue(w);
    await resolve({ applySuggestion: true });
    expect(w.type).toBe('white');
    expect(w.normalizedKey).toBe('stale');
  });

  test('a unique-key collision is a 409 merge-hint and the report stays pending', async () => {
    const r = report();
    const w = wine({ save: jest.fn().mockRejectedValue({ code: 11000 }) });
    WineReport.findById.mockResolvedValue(r);
    WineDefinition.findById.mockResolvedValue(w);
    const res = await resolve({ applySuggestion: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/merge/i);
    expect(r.save).not.toHaveBeenCalled();
    expect(r.status).toBe('pending');
  });

  test('apply on a report without a suggestion is a 400; plain resolve never loads the wine', async () => {
    const r = report({ suggestedField: undefined, suggestedValue: undefined });
    WineReport.findById.mockResolvedValue(r);
    expect((await resolve({ applySuggestion: true })).status).toBe(400);

    const r2 = report();
    WineReport.findById.mockResolvedValue(r2);
    const res = await resolve({});
    expect(res.status).toBe(200);
    expect(WineDefinition.findById).not.toHaveBeenCalled();
    expect(r2.status).toBe('resolved');
  });
});
