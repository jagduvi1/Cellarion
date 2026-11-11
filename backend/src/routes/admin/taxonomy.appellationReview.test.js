/**
 * The appellation review queue of the admin taxonomy routes:
 *   GET  /api/admin/taxonomy/appellations/unmatched
 *   POST /api/admin/taxonomy/appellations/unmatched/dismiss
 *   GET  /api/admin/taxonomy/appellations/dismissed
 *   POST /api/admin/taxonomy/appellations/dismissed/restore
 *
 * Wines store an appellation as free text; the queue lists the strings no
 * curated appellation covers, and an admin either promotes one or dismisses
 * it. The work is in services/taxonomyReview (tested there). This suite pins
 * the route contract: what is handed to the service, how its answers become
 * status codes, the audit rows, and that a successful write drops the public
 * taxonomy list cache while a refused one does not.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({
  getIsAvailable: jest.fn(() => false),
  indexWine: jest.fn(),
  removeWine: jest.fn(),
  fullSync: jest.fn(),
  waitForTasks: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/taxonomyReview', () => ({
  listPendingRegions: jest.fn(),
  listUnmatchedAppellations: jest.fn(),
  appellationRefsError: jest.fn(),
  dismissUnmatchedAppellation: jest.fn(),
  restoreDismissedAppellation: jest.fn(),
  listDismissedAppellations: jest.fn(),
}));
jest.mock('../taxonomy', () => ({ clearTaxonomyListCache: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { logAudit } = require('../../services/audit');
const {
  listUnmatchedAppellations, dismissUnmatchedAppellation, restoreDismissedAppellation, listDismissedAppellations,
} = require('../../services/taxonomyReview');
const { clearTaxonomyListCache } = require('../taxonomy');
const router = require('./taxonomy');

const ADMIN_ID = '64b000000000000000000001';
const token = (roles) => jwt.sign({ id: ADMIN_ID, roles }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/taxonomy', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const call = (method, path, body, roles = ['admin']) => fetch(`${baseUrl}/api/admin/taxonomy${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(roles)}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// The cache is dropped when the response has finished; give that a turn.
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe('GET /appellations/unmatched', () => {
  test('lists the strings no curated appellation covers, with their count', async () => {
    const items = [
      { key: 'cotes de nowhere', name: 'Côtes de Nowhere', wineCount: 3 },
      { key: 'grand vin', name: 'Grand Vin', wineCount: 1 },
    ];
    listUnmatchedAppellations.mockResolvedValue(items);
    const res = await call('GET', '/appellations/unmatched');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 2, items });
  });

  test('answers 500 when the scan fails', async () => {
    listUnmatchedAppellations.mockRejectedValue(new Error('db down'));
    const res = await call('GET', '/appellations/unmatched');

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to list unmatched appellations');
  });
});

describe('POST /appellations/unmatched/dismiss', () => {
  test('a new dismissal answers 201, is audited with the string and its reason, and drops the list cache', async () => {
    const result = { created: true, key: 'grand vin', name: 'Grand Vin' };
    dismissUnmatchedAppellation.mockResolvedValue(result);
    const res = await call('POST', '/appellations/unmatched/dismiss', { name: 'Grand Vin', reason: 'a label slogan' });
    await settled();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(result);
    expect(dismissUnmatchedAppellation).toHaveBeenCalledWith({ name: 'Grand Vin', reason: 'a label slogan', userId: ADMIN_ID });
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.taxonomy.appellationDismiss', { type: 'appellation' },
      { key: 'grand vin', name: 'Grand Vin', reason: 'a label slogan', already: false },
    );
    expect(clearTaxonomyListCache).toHaveBeenCalledTimes(1);
  });

  test('a string that was already dismissed answers 200 and says so in the audit row', async () => {
    dismissUnmatchedAppellation.mockResolvedValue({ created: false, key: 'grand vin', name: 'Grand Vin' });
    const res = await call('POST', '/appellations/unmatched/dismiss', { name: 'Grand Vin' });

    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][3].already).toBe(true);
  });

  test('what the service refuses is a 400 with its message, with no audit row and the cache left alone', async () => {
    dismissUnmatchedAppellation.mockResolvedValue({ error: 'name is required' });
    const res = await call('POST', '/appellations/unmatched/dismiss', {});
    await settled();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name is required' });
    expect(dismissUnmatchedAppellation).toHaveBeenCalledWith({ name: undefined, reason: undefined, userId: ADMIN_ID });
    expect(logAudit).not.toHaveBeenCalled();
    expect(clearTaxonomyListCache).not.toHaveBeenCalled();
  });

  test('answers 500 when the service throws', async () => {
    dismissUnmatchedAppellation.mockRejectedValue(new Error('db down'));
    const res = await call('POST', '/appellations/unmatched/dismiss', { name: 'Grand Vin' });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to dismiss appellation');
  });

  test('is for admins only', async () => {
    const res = await call('POST', '/appellations/unmatched/dismiss', { name: 'Grand Vin' }, ['user']);

    expect(res.status).toBe(403);
    expect(dismissUnmatchedAppellation).not.toHaveBeenCalled();
  });
});

describe('GET /appellations/dismissed', () => {
  test('lists what was dismissed, with its count', async () => {
    const items = [{ key: 'grand vin', name: 'Grand Vin', reason: 'a label slogan' }];
    listDismissedAppellations.mockResolvedValue(items);
    const res = await call('GET', '/appellations/dismissed');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 1, items });
  });

  test('answers 500 when the list fails', async () => {
    listDismissedAppellations.mockRejectedValue(new Error('db down'));
    const res = await call('GET', '/appellations/dismissed');

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to list dismissed appellations');
  });
});

describe('POST /appellations/dismissed/restore', () => {
  test('lifts the dismissal, audits it by key and drops the list cache', async () => {
    const result = { restored: true, key: 'grand vin' };
    restoreDismissedAppellation.mockResolvedValue(result);
    const res = await call('POST', '/appellations/dismissed/restore', { name: 'Grand Vin' });
    await settled();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(restoreDismissedAppellation).toHaveBeenCalledWith('Grand Vin');
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'admin.taxonomy.appellationRestore', { type: 'appellation' }, { key: 'grand vin' },
    );
    expect(clearTaxonomyListCache).toHaveBeenCalledTimes(1);
  });

  test('answers 404 when no dismissal is recorded for the string', async () => {
    restoreDismissedAppellation.mockResolvedValue({ restored: false, key: 'grand vin' });
    const res = await call('POST', '/appellations/dismissed/restore', { name: 'Grand Vin' });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('No dismissal recorded for that string');
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('what the service refuses is a 400 with its message', async () => {
    restoreDismissedAppellation.mockResolvedValue({ error: 'name is required' });
    const res = await call('POST', '/appellations/dismissed/restore', {});

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name is required' });
    expect(restoreDismissedAppellation).toHaveBeenCalledWith(undefined);
  });

  test('answers 500 when the service throws', async () => {
    restoreDismissedAppellation.mockRejectedValue(new Error('db down'));
    const res = await call('POST', '/appellations/dismissed/restore', { name: 'Grand Vin' });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to restore appellation');
  });

  test('is for admins only', async () => {
    const res = await call('POST', '/appellations/dismissed/restore', { name: 'Grand Vin' }, ['user']);

    expect(res.status).toBe(403);
    expect(restoreDismissedAppellation).not.toHaveBeenCalled();
  });
});
