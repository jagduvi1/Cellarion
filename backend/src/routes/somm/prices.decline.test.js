/**
 * POST /api/somm/prices/requests/:id/decline — decline a price-tracking
 * request WITH a required reason (support ticket 6a703236: junk requests —
 * e.g. everyday retail wines with no secondary market — had no exit from the
 * queue except fulfilment).
 *
 * WHY THIS TEST EXISTS:
 * The decline is a three-part contract and every part must hold:
 *   - a 5–500 char PLAIN-TEXT reason is REQUIRED — HTML is stripped BEFORE
 *     the length check, so "<b>ok</b>" cannot sneak past as 9 chars
 *   - a PriceTrackingSkip is recorded for the pair (the suppression that
 *     keeps future user requests from re-queueing it) and the request doc is
 *     deleted — declining twice is a clean 404, never a double notification
 *   - every requester is notified WITH the verbatim reason
 * Plus: somm/admin-only, and GET /queue must hide any pair a skip exists for.
 *
 * Real router + real requireAuth/requireSommOrAdmin (HS256 test tokens);
 * models and side-effect services are mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/labelScan', () => ({ suggestPrice: jest.fn() }));
jest.mock('../../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  getSnapshotsForDates: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../../models/WineVintagePrice', () => ({ aggregate: jest.fn(), find: jest.fn() }));
jest.mock('../../models/PriceTrackingRequest', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../models/PriceTrackingSkip', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), exists: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../../models/PriceTrackingSkip');
const WineVintagePrice = require('../../models/WineVintagePrice');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');
const { createNotification } = require('../../services/notifications');
const { logAudit } = require('../../services/audit');
const pricesRouter = require('./prices');

const SOMM_ID = '64b000000000000000000001';
const USER_A = '64b000000000000000000002';
const USER_B = '64b000000000000000000003';
const WINE_ID = '64b0000000000000000000ee';
const WINE_2 = '64b0000000000000000000ef';
const REQ_ID = '64b0000000000000000000aa';

// Minimal chainable query mock: chained calls return the chain; awaiting it
// (or .lean()) resolves `result`.
const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/somm/prices', pricesRouter);
  return app;
}

function request(method, url, { userId = SOMM_ID, roles = ['somm'], body } = {}) {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method,
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${jwt.sign({ id: userId, roles }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

const decline = (reason, opts = {}) =>
  request('POST', `/api/somm/prices/requests/${REQ_ID}/decline`, { body: reason === undefined ? {} : { reason }, ...opts });

function makeRequestDoc(over = {}) {
  return {
    _id: REQ_ID,
    wineDefinition: WINE_ID,
    vintage: '2018',
    requesters: [
      { user: USER_A, requestedAt: new Date('2026-07-01'), note: 'please track' },
      { user: USER_B, requestedAt: new Date('2026-07-02') },
    ],
    firstRequestedAt: new Date('2026-07-01'),
    lastRequestedAt: new Date('2026-07-02'),
    deleteOne: jest.fn().mockResolvedValue({}),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.findById.mockReturnValue(chain({ _id: WINE_ID, name: 'Everyday Red', producer: 'Big Brand' }));
  PriceTrackingSkip.findOneAndUpdate.mockResolvedValue({});
});

describe('POST /api/somm/prices/requests/:id/decline', () => {
  test('declines with a reason: skip recorded, request deleted, every requester notified with the verbatim reason', async () => {
    const doc = makeRequestDoc();
    PriceTrackingRequest.findById.mockResolvedValue(doc);

    const { status, body } = await decline('  Everyday <b>retail</b> wine — no secondary market.  ');

    expect(status).toBe(200);
    expect(body.requestersNotified).toBe(2);

    // The suppression: a skip upserted on the pair with the STRIPPED reason.
    const [filter, update] = PriceTrackingSkip.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ wineDefinition: WINE_ID, vintage: '2018' });
    expect(update.$setOnInsert).toMatchObject({
      wineDefinition: WINE_ID,
      vintage: '2018',
      reason: 'Everyday retail wine — no secondary market.',
      skippedBy: SOMM_ID,
    });

    expect(doc.deleteOne).toHaveBeenCalledTimes(1);

    // Both requesters, wine label + reason in the message.
    expect(createNotification).toHaveBeenCalledTimes(2);
    const [, type, title, message, link] = createNotification.mock.calls[0];
    expect(createNotification.mock.calls.map((c) => c[0])).toEqual([USER_A, USER_B]);
    expect(type).toBe('price_tracking_declined');
    expect(title).toMatch(/declined/i);
    expect(message).toMatch(/Big Brand — Everyday Red 2018/);
    expect(message).toMatch(/Reason: Everyday retail wine — no secondary market\./);
    expect(link).toBeNull();

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'somm.price.decline',
      { type: 'wine', id: WINE_ID },
      expect.objectContaining({ vintage: '2018', reason: 'Everyday retail wine — no secondary market.', requesters: 2 })
    );
  });

  test('admin role may decline too', async () => {
    PriceTrackingRequest.findById.mockResolvedValue(makeRequestDoc());
    const { status } = await decline('No secondary market for this bottling.', { roles: ['admin'] });
    expect(status).toBe(200);
  });

  test('missing reason → 400, nothing read or mutated', async () => {
    const { status, body } = await decline(undefined);
    expect(status).toBe(400);
    expect(body.error).toMatch(/reason/i);
    expect(PriceTrackingRequest.findById).not.toHaveBeenCalled();
    expect(PriceTrackingSkip.findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test.each([
    ['too short', 'no'],
    ['HTML-padded below the minimum once stripped', '<b>ok</b>'],
    ['HTML only', '<p><br/></p>'],
    ['non-string', { $gt: '' }],
  ])('rejects a reason that is %s → 400', async (_label, reason) => {
    const { status } = await decline(reason);
    expect(status).toBe(400);
    expect(PriceTrackingRequest.findById).not.toHaveBeenCalled();
    expect(PriceTrackingSkip.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('rejects a reason over 500 chars → 400', async () => {
    const { status, body } = await decline('x'.repeat(501));
    expect(status).toBe(400);
    expect(body.error).toMatch(/too long/i);
    expect(PriceTrackingRequest.findById).not.toHaveBeenCalled();
  });

  test('somm/admin only: a plain user gets 403 before any read', async () => {
    const { status } = await decline('No secondary market.', { roles: ['user'] });
    expect(status).toBe(403);
    expect(PriceTrackingRequest.findById).not.toHaveBeenCalled();
  });

  test('invalid request id → 400', async () => {
    const { status } = await request('POST', '/api/somm/prices/requests/not-an-id/decline', { body: { reason: 'No secondary market.' } });
    expect(status).toBe(400);
  });

  test('double-decline: the request is gone, so the second call is a clean 404 with no skip write and no re-notification', async () => {
    PriceTrackingRequest.findById.mockResolvedValue(null);
    const { status, body } = await decline('No secondary market.');
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
    expect(PriceTrackingSkip.findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('GET /api/somm/prices/queue — declined pairs are suppressed', () => {
  test('a pair with a PriceTrackingSkip is dropped from the queue (and from the downstream price/bottle lookups)', async () => {
    PriceTrackingRequest.find.mockReturnValue(chain([
      {
        _id: '64b0000000000000000000a1',
        wineDefinition: { _id: WINE_ID, name: 'Declined Red' },
        vintage: '2018',
        requesters: [{ user: { username: 'kalle' }, note: 'hi' }],
        firstRequestedAt: new Date('2026-07-01'),
      },
      {
        _id: '64b0000000000000000000a2',
        wineDefinition: { _id: WINE_2, name: 'Kept Nebbiolo' },
        vintage: '2016',
        requesters: [{ user: { username: 'stina' } }],
        firstRequestedAt: new Date('2026-07-02'),
      },
    ]));
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: WINE_ID, vintage: '2018' }]));
    WineVintagePrice.aggregate.mockResolvedValue([]);
    Bottle.aggregate.mockResolvedValue([]);

    const { status, body } = await request('GET', '/api/somm/prices/queue');

    expect(status).toBe(200);
    expect(body.queue).toHaveLength(1);
    expect(body.queue[0].requestId).toBe('64b0000000000000000000a2');
    // Suppression happens BEFORE the downstream aggregations — the declined
    // wine must not even be looked up.
    const priceMatch = WineVintagePrice.aggregate.mock.calls[0][0][0].$match;
    expect(priceMatch.wineDefinition.$in).toEqual([WINE_2]);
  });

  test('a skip on the same wine but another vintage does NOT hide the requested pair', async () => {
    PriceTrackingRequest.find.mockReturnValue(chain([
      {
        _id: '64b0000000000000000000a1',
        wineDefinition: { _id: WINE_ID, name: 'Barolo' },
        vintage: '2018',
        requesters: [{ user: { username: 'kalle' } }],
        firstRequestedAt: new Date('2026-07-01'),
      },
    ]));
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: WINE_ID, vintage: '2015' }]));
    WineVintagePrice.aggregate.mockResolvedValue([]);
    Bottle.aggregate.mockResolvedValue([]);

    const { status, body } = await request('GET', '/api/somm/prices/queue');
    expect(status).toBe(200);
    expect(body.queue).toHaveLength(1);
  });

  test('all pairs skipped → empty queue, no downstream aggregation at all', async () => {
    PriceTrackingRequest.find.mockReturnValue(chain([
      {
        _id: '64b0000000000000000000a1',
        wineDefinition: { _id: WINE_ID, name: 'Declined Red' },
        vintage: '2018',
        requesters: [{ user: { username: 'kalle' } }],
        firstRequestedAt: new Date('2026-07-01'),
      },
    ]));
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: WINE_ID, vintage: '2018' }]));

    const { status, body } = await request('GET', '/api/somm/prices/queue');
    expect(status).toBe(200);
    expect(body.queue).toEqual([]);
    expect(WineVintagePrice.aggregate).not.toHaveBeenCalled();
    expect(Bottle.aggregate).not.toHaveBeenCalled();
  });
});
