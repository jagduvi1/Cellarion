/**
 * The classification taxonomy routes (support ticket 2026-10-29): list with
 * wine counts and the review flag, create with a kind, approve (idempotent,
 * audited), delete refused while a wine references the row.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false), indexWine: jest.fn(), removeWine: jest.fn(), bulkIndexWines: jest.fn(),
  bulkIndexBottles: jest.fn(), fullSync: jest.fn(), fullSyncBottles: jest.fn(), waitForTasks: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/Country', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../../models/Region', () => ({ findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../../models/Grape', () => ({ findById: jest.fn(), find: jest.fn(), exists: jest.fn() }));
jest.mock('../../models/Classification', () => {
  const Classification = jest.fn(function (fields) {
    Object.assign(this, fields);
    this.save = jest.fn().mockResolvedValue(undefined);
  });
  Classification.KINDS = ['vineyard_rank', 'ripeness', 'ageing', 'other'];
  Classification.findById = jest.fn();
  Classification.find = jest.fn();
  Classification.findByIdAndDelete = jest.fn();
  return Classification;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Classification = require('../../models/Classification');
const WineDefinition = require('../../models/WineDefinition');
const { logAudit } = require('../../services/audit');
const router = require('./taxonomy');

const ADMIN_ID = '64b000000000000000000001';
const ID = '64b0000000000000000000c1';

let server; let baseUrl;
beforeAll((done) => {
  const app = express(); app.use(express.json()); app.use('/api/admin/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
const token = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');
const call = (method, path, body) => fetch(`${baseUrl}/api/admin/taxonomy${path}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: body ? JSON.stringify(body) : undefined,
});
beforeEach(() => jest.clearAllMocks());

test('GET /classifications lists rows with their wine count and the review flag', async () => {
  Classification.find.mockReturnValue({ sort: () => ({ lean: async () => [
    { _id: ID, name: 'Spätlese', kind: 'ripeness', createdByUser: false, reviewedAt: new Date() },
    { _id: '64b0000000000000000000c2', name: 'Honey Tier', kind: 'other', createdByUser: true, reviewedAt: null },
  ] }) });
  WineDefinition.aggregate.mockResolvedValue([{ _id: ID, n: 12 }]);
  const res = await call('GET', '/classifications');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.classifications[0]).toMatchObject({ name: 'Spätlese', wineCount: 12, needsReview: false });
  expect(body.classifications[1]).toMatchObject({ name: 'Honey Tier', wineCount: 0, needsReview: true });
  expect(body.needsReviewCount).toBe(1);
  expect(body.kinds).toEqual(['vineyard_rank', 'ripeness', 'ageing', 'other']);
});

test('POST /classifications needs a name and a known kind; a good one is created and audited', async () => {
  expect((await call('POST', '/classifications', { name: 'Riserva' })).status).toBe(400);
  expect((await call('POST', '/classifications', { name: 'Riserva', kind: 'vintage' })).status).toBe(400);
  const res = await call('POST', '/classifications', { name: ' Riserva ', kind: 'ageing', system: 'Italian DOC/DOCG tiers', synonyms: ['Riserva Speciale'] });
  expect(res.status).toBe(201);
  const created = Classification.mock.instances[0];
  expect(created).toMatchObject({ name: 'Riserva', kind: 'ageing', normalizedName: 'riserva', synonyms: ['Riserva Speciale'], createdBy: ADMIN_ID });
  expect(created.save).toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.taxonomy.create', expect.objectContaining({ type: 'classification' }), expect.objectContaining({ name: 'Riserva' }));
});

test('POST /classifications/:id/approve stamps the review once and audits once', async () => {
  const doc = { _id: ID, name: 'Honey Tier', createdByUser: true, reviewedAt: null, save: jest.fn().mockResolvedValue(undefined) };
  Classification.findById.mockResolvedValue(doc);
  expect((await call('POST', `/classifications/${ID}/approve`)).status).toBe(200);
  expect(doc.reviewedAt).toBeInstanceOf(Date);
  expect(doc.reviewedBy).toBe(ADMIN_ID);
  expect(doc.createdByUser).toBe(true);
  expect(logAudit).toHaveBeenCalledTimes(1);
  const again = await (await call('POST', `/classifications/${ID}/approve`)).json();
  expect(again.already).toBe(true);
  expect(doc.save).toHaveBeenCalledTimes(1);
  expect((await call('POST', '/classifications/nope/approve')).status).toBe(400);
});

test('DELETE /classifications/:id is refused while a wine carries the row', async () => {
  Classification.findById.mockResolvedValue({ _id: ID, name: 'Riserva' });
  WineDefinition.countDocuments.mockResolvedValue(3);
  const res = await call('DELETE', `/classifications/${ID}`);
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/3 wine/);
  expect(Classification.findByIdAndDelete).not.toHaveBeenCalled();

  WineDefinition.countDocuments.mockResolvedValue(0);
  Classification.findByIdAndDelete.mockResolvedValue({ _id: ID, name: 'Riserva' });
  expect((await call('DELETE', `/classifications/${ID}`)).status).toBe(200);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.taxonomy.delete', expect.objectContaining({ type: 'classification' }), expect.anything());
});
