/**
 * The label sweetness term routes (GitHub discussion #1754): list with wine
 * counts and the review flag, create with a scale and a band of that scale,
 * the word and scale of a term that wines carry are frozen (their identity
 * keys are built from it), delete refused while a wine references the row,
 * approve idempotent and audited.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false), indexWine: jest.fn(), removeWine: jest.fn(),
  fullSync: jest.fn(), waitForTasks: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/Country', () => ({ exists: jest.fn(), findById: jest.fn() }));
jest.mock('../../models/Region', () => ({ findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../../models/Grape', () => ({ findById: jest.fn(), find: jest.fn(), exists: jest.fn() }));
jest.mock('../../models/Classification', () => {
  const Classification = jest.fn();
  Classification.KINDS = ['vineyard_rank', 'ripeness', 'ageing', 'other'];
  Classification.findById = jest.fn(); Classification.find = jest.fn(); Classification.findByIdAndDelete = jest.fn();
  return Classification;
});
jest.mock('../../models/SweetnessTerm', () => {
  const SweetnessTerm = jest.fn(function (fields) {
    Object.assign(this, fields);
    this.save = jest.fn().mockResolvedValue(undefined);
  });
  SweetnessTerm.SCALES = ['still', 'sparkling'];
  SweetnessTerm.BANDS = { still: ['dry', 'off-dry', 'medium-sweet', 'sweet'], sparkling: ['brut-nature', 'extra-brut', 'brut', 'extra-dry', 'sec', 'demi-sec', 'doux'] };
  SweetnessTerm.ALL_BANDS = [...SweetnessTerm.BANDS.still, ...SweetnessTerm.BANDS.sparkling];
  SweetnessTerm.findById = jest.fn();
  SweetnessTerm.find = jest.fn();
  SweetnessTerm.findByIdAndDelete = jest.fn();
  SweetnessTerm.estimatedDocumentCount = jest.fn();
  return SweetnessTerm;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const SweetnessTerm = require('../../models/SweetnessTerm');
const WineDefinition = require('../../models/WineDefinition');
const { logAudit } = require('../../services/audit');
const router = require('./taxonomy');

const ADMIN_ID = '64b000000000000000000001';
const ID = '64b0000000000000000000d1';

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
const row = (over = {}) => ({ _id: ID, name: 'Trocken', normalizedName: 'trocken', scale: 'still', band: 'dry', regulated: true, synonyms: [], save: jest.fn().mockResolvedValue(undefined), ...over });
beforeEach(() => jest.clearAllMocks());

test('GET /sweetness-terms lists rows with their wine count, the review flag, the scales and the bands', async () => {
  SweetnessTerm.find.mockReturnValue({ sort: () => ({ lean: async () => [
    row({ createdByUser: false, reviewedAt: new Date() }),
    { _id: '64b0000000000000000000d2', name: 'Honigsüß', scale: 'still', band: 'sweet', createdByUser: true, reviewedAt: null },
  ] }) });
  WineDefinition.aggregate.mockResolvedValue([{ _id: ID, n: 7 }]);
  const res = await call('GET', '/sweetness-terms');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sweetnessTerms[0]).toMatchObject({ name: 'Trocken', wineCount: 7, needsReview: false });
  expect(body.sweetnessTerms[1]).toMatchObject({ name: 'Honigsüß', wineCount: 0, needsReview: true });
  expect(body.needsReviewCount).toBe(1);
  expect(body.scales).toEqual(['still', 'sparkling']);
  expect(body.bands.still).toEqual(['dry', 'off-dry', 'medium-sweet', 'sweet']);
});

test('POST /sweetness-terms needs a name, a known scale and a band OF THAT SCALE; a good one is created and audited', async () => {
  expect((await call('POST', '/sweetness-terms', { scale: 'still', band: 'dry' })).status).toBe(400);
  expect((await call('POST', '/sweetness-terms', { name: 'Lieblich', scale: 'fortified', band: 'sweet' })).status).toBe(400);
  const wrongScale = await call('POST', '/sweetness-terms', { name: 'Lieblich', scale: 'still', band: 'sec' });
  expect(wrongScale.status).toBe(400);
  expect((await wrongScale.json()).error).toMatch(/still bands/);

  const res = await call('POST', '/sweetness-terms', { name: ' Lieblich ', scale: 'still', band: 'medium-sweet', system: 'EU 2019/33 Annex III A (de)', synonyms: ['Lieblich '] });
  expect(res.status).toBe(201);
  const created = SweetnessTerm.mock.calls[0][0];
  expect(created).toMatchObject({ name: 'Lieblich', normalizedName: 'lieblich', scale: 'still', band: 'medium-sweet', regulated: true, createdBy: ADMIN_ID, reviewedBy: ADMIN_ID, synonyms: ['Lieblich'] });
  expect(created.reviewedAt).toBeInstanceOf(Date);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.taxonomy.sweetness.create', expect.objectContaining({ type: 'sweetnessTerm' }), expect.objectContaining({ name: 'Lieblich', band: 'medium-sweet' }));
});

test('POST: a customary word is stored unregulated; ß keys as ss', async () => {
  const res = await call('POST', '/sweetness-terms', { name: 'Edelsüß', scale: 'still', band: 'sweet', regulated: false });
  expect(res.status).toBe(201);
  expect(SweetnessTerm.mock.calls[0][0]).toMatchObject({ name: 'Edelsüß', normalizedName: 'edelsuss', regulated: false });
});

test('PUT: the word and the scale of a term wines carry are frozen; its band, system and flag are not', async () => {
  SweetnessTerm.findById.mockResolvedValue(row());
  WineDefinition.countDocuments.mockResolvedValue(12);
  const renamed = await call('PUT', `/sweetness-terms/${ID}`, { name: 'Trocken (dry)' });
  expect(renamed.status).toBe(400);
  expect((await renamed.json()).error).toMatch(/12 wine\(s\) carry this term/);
  expect((await call('PUT', `/sweetness-terms/${ID}`, { scale: 'sparkling', band: 'sec' })).status).toBe(400);

  // A respelling that keys the same word is not a change of word.
  const doc = row();
  SweetnessTerm.findById.mockResolvedValue(doc);
  expect((await call('PUT', `/sweetness-terms/${ID}`, { name: 'trocken', regulated: false, system: 'Customary' })).status).toBe(200);
  expect(doc).toMatchObject({ name: 'trocken', regulated: false, system: 'Customary' });
  expect(doc.save).toHaveBeenCalled();

  // A band of another scale is refused even on an unreferenced row.
  WineDefinition.countDocuments.mockResolvedValue(0);
  SweetnessTerm.findById.mockResolvedValue(row());
  expect((await call('PUT', `/sweetness-terms/${ID}`, { band: 'brut' })).status).toBe(400);
});

test('PUT changing only the scale of an unreferenced row is a 400 that asks for a band of the new scale, never a 500', async () => {
  WineDefinition.countDocuments.mockResolvedValue(0);
  const doc = row();
  SweetnessTerm.findById.mockResolvedValue(doc);
  const res = await call('PUT', `/sweetness-terms/${ID}`, { scale: 'sparkling' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/band of that scale.*brut-nature/);
  expect(doc.save).not.toHaveBeenCalled();
  // With the band, the move is fine.
  expect((await call('PUT', `/sweetness-terms/${ID}`, { scale: 'sparkling', band: 'sec' })).status).toBe(200);
  expect(doc).toMatchObject({ scale: 'sparkling', band: 'sec' });
});

test('DELETE refuses while a wine carries the term, deletes and audits otherwise', async () => {
  SweetnessTerm.findById.mockResolvedValue(row());
  WineDefinition.countDocuments.mockResolvedValue(3);
  expect((await call('DELETE', `/sweetness-terms/${ID}`)).status).toBe(400);
  expect(SweetnessTerm.findByIdAndDelete).not.toHaveBeenCalled();

  WineDefinition.countDocuments.mockResolvedValue(0);
  expect((await call('DELETE', `/sweetness-terms/${ID}`)).status).toBe(200);
  expect(SweetnessTerm.findByIdAndDelete).toHaveBeenCalledWith(ID);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.taxonomy.sweetness.delete', expect.anything(), expect.objectContaining({ name: 'Trocken' }));
});

test('POST /:id/approve stamps once and is idempotent', async () => {
  const doc = row({ createdByUser: true, reviewedAt: null });
  SweetnessTerm.findById.mockResolvedValue(doc);
  expect((await call('POST', `/sweetness-terms/${ID}/approve`)).status).toBe(200);
  expect(doc.reviewedAt).toBeInstanceOf(Date);
  expect(String(doc.reviewedBy)).toBe(ADMIN_ID);
  expect(doc.save).toHaveBeenCalledTimes(1);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.taxonomy.sweetness.approve', expect.anything(), expect.anything());

  const again = await call('POST', `/sweetness-terms/${ID}/approve`);
  expect((await again.json()).already).toBe(true);
  expect(doc.save).toHaveBeenCalledTimes(1);
});

test('an unknown id is 404, a malformed one 400', async () => {
  SweetnessTerm.findById.mockResolvedValue(null);
  expect((await call('DELETE', `/sweetness-terms/${ID}`)).status).toBe(404);
  expect((await call('PUT', '/sweetness-terms/nope', { band: 'dry' })).status).toBe(400);
});
