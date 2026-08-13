/**
 * Closing a wine report notifies the reporter. Before this, resolve/dismiss
 * only flipped a status the user had to go hunting for on the Support page,
 * so a handled report and an ignored one looked identical to them.
 *
 * Pins: every close notifies (reply or not); the reply text is the message
 * when present and a plain acknowledgement stands in when absent; the reply
 * is stored on the field the Support page actually renders; a failed save
 * never notifies; oversized/non-string replies are refused.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineReport', () => ({ findById: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), bulkIndexBottles: jest.fn() }));
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineReport = require('../../models/WineReport');
const { createNotification } = require('../../services/notifications');
const router = require('./wineReports');

const ADMIN_ID = '64b000000000000000000001';
const REPORT_ID = '64b0000000000000000000d1';
const USER_ID = '64b0000000000000000000a1';
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

const call = (action, body) => fetch(`${baseUrl}/api/admin/wine-reports/${REPORT_ID}/${action}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
  body: JSON.stringify(body),
});

// populate() is what attaches the wine the notification names, so the stub
// mirrors the real thing rather than resolving to a bare undefined.
const report = (over = {}) => {
  const r = {
    _id: REPORT_ID, status: 'pending', user: USER_ID, wineDefinition: 'w1',
    suggestedField: undefined, suggestedValue: undefined,
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
  r.populate = jest.fn(async (path) => {
    if (path === 'wineDefinition') r.wineDefinition = { name: 'Tinto de Familia', producer: 'Zuccardi' };
  });
  return r;
};

beforeEach(() => jest.clearAllMocks());

describe('closing a wine report notifies the reporter', () => {
  test('resolve with a reply sends that reply, to the reporter, linked to Support', async () => {
    const r = report();
    WineReport.findById.mockResolvedValue(r);

    const res = await call('resolve', { response: 'You were right — window corrected to 2036.' });

    expect(res.status).toBe(200);
    expect(r.adminResponse).toBe('You were right — window corrected to 2036.');
    expect(r.respondedAt).toBeInstanceOf(Date);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [userId, type, title, message, link] = createNotification.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(type).toBe('wine_report_resolved');
    expect(title).toMatch(/resolved/i);
    expect(message).toBe('You were right — window corrected to 2036.');
    expect(link).toBe('/support');
  });

  test('resolve WITHOUT a reply still notifies, naming the wine', async () => {
    const r = report();
    WineReport.findById.mockResolvedValue(r);

    const res = await call('resolve', {});

    expect(res.status).toBe(200);
    expect(r.adminResponse).toBeUndefined();
    expect(createNotification).toHaveBeenCalledTimes(1);
    const message = createNotification.mock.calls[0][3];
    expect(message).toMatch(/Tinto de Familia/);
    expect(message).toMatch(/Zuccardi/);
  });

  test('dismiss notifies with its own type and does not claim a change was made', async () => {
    const r = report();
    WineReport.findById.mockResolvedValue(r);

    const res = await call('dismiss', {});

    expect(res.status).toBe(200);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [, type, , message] = createNotification.mock.calls[0];
    expect(type).toBe('wine_report_dismissed');
    expect(message).toMatch(/left the record as it stands/i);
  });

  test('a whitespace-only reply is treated as no reply, not as an empty message', async () => {
    const r = report();
    WineReport.findById.mockResolvedValue(r);

    await call('resolve', { response: '   \n  ' });

    expect(r.adminResponse).toBeUndefined();
    expect(r.respondedAt).toBeUndefined();
    expect(createNotification.mock.calls[0][3]).toMatch(/Tinto de Familia/);
  });

  test('HTML in the reply is stripped before it reaches the reporter', async () => {
    const r = report();
    WineReport.findById.mockResolvedValue(r);

    await call('resolve', { response: 'Fixed <script>alert(1)</script> now' });

    expect(r.adminResponse).not.toMatch(/<script>/i);
    expect(createNotification.mock.calls[0][3]).not.toMatch(/<script>/i);
  });

  test('an over-long or non-string reply is refused before anything is written', async () => {
    const r = report();
    WineReport.findById.mockResolvedValue(r);
    expect((await call('resolve', { response: 'x'.repeat(2001) })).status).toBe(400);

    const r2 = report();
    WineReport.findById.mockResolvedValue(r2);
    expect((await call('dismiss', { response: { evil: true } })).status).toBe(400);

    expect(r.save).not.toHaveBeenCalled();
    expect(r2.save).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a report already closed is refused and re-notifies nobody', async () => {
    WineReport.findById.mockResolvedValue(report({ status: 'resolved' }));
    expect((await call('resolve', { response: 'again' })).status).toBe(400);
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a save failure notifies nobody — no ping for a close that did not happen', async () => {
    const r = report({ save: jest.fn().mockRejectedValue(new Error('mongo down')) });
    WineReport.findById.mockResolvedValue(r);

    expect((await call('resolve', { response: 'hi' })).status).toBe(500);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
