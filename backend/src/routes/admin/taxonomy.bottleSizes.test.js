/**
 * POST /api/admin/taxonomy/bottle-sizes/remap — bulk-remap one stored bottle
 * size to a canonical code. Runs the real services/bottleSizeMaintenance with
 * the Bottle model mocked.
 *
 * Pins: the audit row is one the AuditLog model can store with the remap's
 * from/to (resource is a typed sub-document, so values put there are dropped);
 * bad input answers 400 with its message; any other failure answers 500 and
 * is logged.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false), fullSync: jest.fn(), fullSyncBottles: jest.fn(),
  indexWine: jest.fn(), removeWine: jest.fn(), bulkIndexWines: jest.fn(),
  bulkIndexBottles: jest.fn(), waitForTasks: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/taxonomyMerge', () => ({ mergeGrapes: jest.fn(), mergeRegions: jest.fn(), mergeCountries: jest.fn() }));
jest.mock('../../services/taxonomyReview', () => ({
  listUnmatchedAppellations: jest.fn(), appellationRefsError: jest.fn(),
  dismissUnmatchedAppellation: jest.fn(), restoreDismissedAppellation: jest.fn(),
  listDismissedAppellations: jest.fn(),
}));
jest.mock('../taxonomy', () => ({ clearTaxonomyListCache: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ updateMany: jest.fn(), aggregate: jest.fn(), distinct: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Bottle = require('../../models/Bottle');
const AuditLog = require('../../models/AuditLog');
const { logAudit } = require('../../services/audit');
const router = require('./taxonomy');

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
const remap = async (body) => {
  const res = await fetch(`${baseUrl}/api/admin/taxonomy/bottle-sizes/remap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => jest.clearAllMocks());

test('remaps, answers the result, and writes an audit row the model can store with from and to', async () => {
  Bottle.updateMany.mockResolvedValue({ modifiedCount: 3 });

  const res = await remap({ from: '1ml', to: '1L' });

  expect(res).toEqual({ status: 200, body: { from: '1ml', to: '1000ml', modified: 3 } });
  expect(Bottle.updateMany).toHaveBeenCalledWith({ bottleSize: '1ml' }, { $set: { bottleSize: '1000ml' } });
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.bottleSize.remap',
    { type: 'bottleSize' }, { from: '1ml', to: '1000ml', modified: 3 });

  const [, action, resource, detail] = logAudit.mock.calls[0];
  const row = new AuditLog({ action, resource, detail });
  expect(row.validateSync()).toBeUndefined();
  expect(row.toObject().resource).toEqual(resource);
  expect(row.detail).toEqual({ from: '1ml', to: '1000ml', modified: 3 });
});

test.each([
  ['no "from"', { to: '750ml' }, '"from" value is required'],
  ['a "to" that is no size', { from: '1ml', to: 'Magnum' }, '"to" must be a valid size (e.g. 750ml or 1.5L)'],
])('400 with the message for %s, and nothing is written', async (_label, body, error) => {
  expect(await remap(body)).toEqual({ status: 400, body: { error } });
  expect(Bottle.updateMany).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});

test('a database failure is a 500, logged, and its message is not sent to the client', async () => {
  Bottle.updateMany.mockRejectedValue(new Error('connection reset by mongod'));
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

  const res = await remap({ from: '1ml', to: '1L' });

  expect(res).toEqual({ status: 500, body: { error: 'Remap failed' } });
  expect(spy).toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
  spy.mockRestore();
});
