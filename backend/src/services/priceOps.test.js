/**
 * services/priceOps — the price-curation body shared by the REST somm routes
 * and the MCP somm tools. The two doors' own suites (routes/somm/prices.*.test.js,
 * mcp/sommTools.test.js) pin their responses; this file pins the shared
 * rules themselves: what is actionable, how the queue sorts, how a vintage
 * and a reason are read, and what an undo may lift.
 */

jest.mock('../models/WineVintagePrice', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'price-1'; this.save = jest.fn().mockResolvedValue(undefined); });
  M.aggregate = jest.fn().mockResolvedValue([]);
  M.deleteOne = jest.fn();
  return M;
});
jest.mock('../models/PriceTrackingRequest', () => ({ findOne: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/PriceTrackingSkip', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('./notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const WineVintagePrice = require('../models/WineVintagePrice');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const WineDefinition = require('../models/WineDefinition');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');
const { createNotification } = require('./notifications');
const { logAudit } = require('./audit');
const ops = require('./priceOps');

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T12:00:00Z').getTime();
const req = (id, vintage, requesters = 1, firstRequestedAt = '2026-01-01') => ({
  _id: `r${id}`, wineDefinition: { _id: `w${id}` }, vintage,
  requesters: Array.from({ length: requesters }, (_, i) => ({ user: `u${i}` })),
  firstRequestedAt: new Date(firstRequestedAt),
});

beforeEach(() => {
  jest.clearAllMocks();
  PriceTrackingSkip.find.mockReturnValue(chain([]));
  WineVintagePrice.aggregate.mockResolvedValue([]);
});

describe('isStalePrice', () => {
  test('no snapshot is actionable; one within 90 days is not; one older is', () => {
    expect(ops.isStalePrice(null, NOW)).toBe(true);
    expect(ops.isStalePrice({ setAt: new Date(NOW - 89 * DAY) }, NOW)).toBe(false);
    expect(ops.isStalePrice({ setAt: new Date(NOW - 91 * DAY) }, NOW)).toBe(true);
  });
});

describe('actionablePriceRequests', () => {
  test('drops requests whose wine is gone and pairs a curator declined, without querying prices when nothing is left', async () => {
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: 'w1', vintage: '2018' }]));
    const rows = await ops.actionablePriceRequests([{ ...req(1, '2018') }, { _id: 'gone', wineDefinition: null, vintage: '2019' }], { now: NOW });
    expect(rows).toEqual([]);
    expect(WineVintagePrice.aggregate).not.toHaveBeenCalled();
  });

  test('a skip on another vintage of the same wine hides nothing, and the price lookup covers only the live wines', async () => {
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: 'w1', vintage: '2015' }]));
    const rows = await ops.actionablePriceRequests([req(1, '2018')], { now: NOW });
    expect(rows).toHaveLength(1);
    expect(WineVintagePrice.aggregate.mock.calls[0][0][0]).toEqual({ $match: { wineDefinition: { $in: ['w1'] } } });
  });

  test('a fresh price removes the pair; a stale one keeps it with the latest snapshot attached; the queue sorts by requesters, then oldest first', async () => {
    WineVintagePrice.aggregate.mockResolvedValue([
      { _id: { wineDefinition: 'w1', vintage: '2018' }, setAt: new Date(NOW - 10 * DAY), price: 40, currency: 'EUR', source: 'auction' },
      { _id: { wineDefinition: 'w2', vintage: '2016' }, setAt: new Date(NOW - 100 * DAY), price: 55, currency: 'USD', source: null },
    ]);
    const rows = await ops.actionablePriceRequests([
      req(1, '2018', 5),
      req(2, '2016', 1, '2026-02-01'),
      req(3, '2019', 1, '2026-01-15'),
      req(4, '2017', 3, '2026-03-01'),
    ], { now: NOW });
    expect(rows.map((r) => r.request._id)).toEqual(['r4', 'r3', 'r2']);
    expect(rows[2].latest).toEqual({ price: 55, currency: 'USD', setAt: new Date(NOW - 100 * DAY), source: null });
    expect(rows[1].latest).toBeNull();
  });
});

describe('parsePriceVintage and normalizeCurrency', () => {
  test('blank is required, junk is invalid with the parser text, Unknown has no price, "nv" is NV', () => {
    expect(ops.parsePriceVintage('  ')).toEqual({ ok: false, code: 'required' });
    expect(ops.parsePriceVintage(undefined)).toEqual({ ok: false, code: 'required' });
    expect(ops.parsePriceVintage('20015')).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/out of range/) });
    expect(ops.parsePriceVintage('unknown')).toEqual({ ok: false, code: 'unknown' });
    expect(ops.parsePriceVintage('nv')).toEqual({ ok: true, value: 'NV' });
    expect(ops.parsePriceVintage(' 2016 ')).toEqual({ ok: true, value: '2016' });
  });

  test('currency defaults to USD, upper-cases, and refuses what the app does not support', () => {
    expect(ops.normalizeCurrency(undefined)).toEqual({ ok: true, value: 'USD' });
    expect(ops.normalizeCurrency('sek')).toEqual({ ok: true, value: 'SEK' });
    expect(ops.normalizeCurrency('XXX')).toEqual({ ok: false, value: 'XXX' });
  });
});

describe('addPriceSnapshot', () => {
  test('takes the rate snapshot before saving, audits with the door, and tells requesters with the request\'s wine label', async () => {
    PriceTrackingRequest.findOne.mockReturnValue(chain({
      requesters: [{ user: 'u1' }, { user: 'u2' }],
      wineDefinition: { name: 'Barolo Castiglione', producer: 'Vietti' },
    }));
    const entry = await ops.addPriceSnapshot({
      wineId: 'w1', vintage: '2019', price: 45, currency: 'EUR', source: '  retail ', sommNotes: '',
      actorId: 'somm1', req: { id: 'req' }, via: 'mcp',
    });
    expect(getOrCreateDailySnapshot.mock.invocationCallOrder[0]).toBeLessThan(entry.save.mock.invocationCallOrder[0]);
    expect(WineVintagePrice.mock.calls[0][0]).toEqual({
      wineDefinition: 'w1', vintage: '2019', price: 45, currency: 'EUR', source: 'retail', sommNotes: undefined, setBy: 'somm1',
    });
    expect(logAudit).toHaveBeenCalledWith({ id: 'req' }, 'somm.price.add', { type: 'wine', id: 'w1' },
      { vintage: '2019', price: 45, currency: 'EUR', via: 'mcp' });
    await new Promise((r) => setImmediate(r));
    expect(PriceTrackingRequest.findOne).toHaveBeenCalledWith({ wineDefinition: 'w1', vintage: '2019' });
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledWith('u1', 'price_tracked', 'Market price updated',
      'A sommelier just added a market price for Vietti — Barolo Castiglione 2019: EUR 45.', '/wines/w1');
    expect(createNotification.mock.calls[0]).toHaveLength(5);
  });

  test('the label falls back to the wine the caller loaded, the audit carries no door key from the web, and a failed rate snapshot is not a failure', async () => {
    getOrCreateDailySnapshot.mockRejectedValueOnce(new Error('rates down'));
    PriceTrackingRequest.findOne.mockReturnValue(chain({ requesters: [{ user: 'u1' }] }));
    await ops.addPriceSnapshot({
      wineId: 'w1', vintage: 'NV', price: 40, currency: 'USD', actorId: 'somm1',
      wine: { name: 'Brut', producer: 'Maison X' }, req: { id: 'req' },
    });
    expect(logAudit.mock.calls[0][3]).toEqual({ vintage: 'NV', price: 40, currency: 'USD' });
    await new Promise((r) => setImmediate(r));
    expect(createNotification.mock.calls[0][3]).toBe('A sommelier just added a market price for Maison X — Brut NV: USD 40.');
  });

  test('nobody is told when no request is open for the pair', async () => {
    PriceTrackingRequest.findOne.mockReturnValue(chain(null));
    await ops.addPriceSnapshot({ wineId: 'w1', vintage: '2019', price: 1, currency: 'USD', actorId: 's' });
    await new Promise((r) => setImmediate(r));
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('validateDeclineReason', () => {
  test('strips HTML before measuring, refuses short, long and non-string reasons', () => {
    expect(ops.validateDeclineReason('  Everyday <b>retail</b> wine.  ')).toEqual({ ok: true, reason: 'Everyday retail wine.' });
    expect(ops.validateDeclineReason('<b>ok</b>')).toMatchObject({ ok: false, code: 'short' });
    expect(ops.validateDeclineReason({ $gt: '' })).toMatchObject({ ok: false, code: 'short' });
    expect(ops.validateDeclineReason('x'.repeat(501))).toMatchObject({ ok: false, code: 'long' });
  });
});

describe('declinePriceRequest and its undo', () => {
  const request = {
    _id: 'r1', wineDefinition: 'w1', vintage: '2018',
    requesters: [{ user: 'u1', requestedAt: new Date('2026-07-01'), note: 'please' }, { user: 'u2', requestedAt: new Date('2026-07-02') }],
    firstRequestedAt: new Date('2026-07-01'), lastRequestedAt: new Date('2026-07-02'),
  };

  test('records the skip with the first decline kept, deletes the request, notifies verbatim, audits, and says whether it created the suppression', async () => {
    WineDefinition.findById.mockReturnValue(chain({ name: 'Everyday Red', producer: 'Big Brand' }));
    PriceTrackingSkip.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false } });
    const out = await ops.declinePriceRequest({ request, reason: 'No secondary market.', actorId: 'somm1', req: { id: 'req' }, via: 'mcp' });
    const [filter, update, options] = PriceTrackingSkip.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ wineDefinition: 'w1', vintage: '2018' });
    expect(update.$setOnInsert).toMatchObject({ wineDefinition: 'w1', vintage: '2018', reason: 'No secondary market.', skippedBy: 'somm1' });
    expect(options).toMatchObject({ upsert: true, includeResultMetadata: true });
    expect(PriceTrackingRequest.deleteOne).toHaveBeenCalledWith({ _id: 'r1' });
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledWith('u1', 'price_tracking_declined', 'Price tracking request declined',
      'Your request to track market price for Big Brand — Everyday Red 2018 was declined by a sommelier. Reason: No secondary market.', null);
    expect(logAudit).toHaveBeenCalledWith({ id: 'req' }, 'somm.price.decline', { type: 'wine', id: 'w1' },
      { vintage: '2018', reason: 'No secondary market.', requesters: 2, via: 'mcp' });
    expect(out.requestersNotified).toBe(2);
    expect(out.prev).toEqual({
      wineDefinition: 'w1', vintage: '2018',
      requesters: [{ user: 'u1', requestedAt: request.requesters[0].requestedAt, note: 'please' }, { user: 'u2', requestedAt: request.requesters[1].requestedAt, note: undefined }],
      firstRequestedAt: request.firstRequestedAt, lastRequestedAt: request.lastRequestedAt, skipCreated: true,
    });
  });

  test('a pre-existing skip is left as it is and prev says so; a deleted wine still declines with a generic label', async () => {
    WineDefinition.findById.mockReturnValue(chain(null));
    PriceTrackingSkip.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: true }, value: { _id: 'sk1' } });
    const out = await ops.declinePriceRequest({ request, reason: 'Junk.', actorId: 'somm1', req: {} });
    expect(out.prev.skipCreated).toBe(false);
    expect(createNotification.mock.calls[0][3]).toMatch(/for this wine 2018 was declined/);
  });

  test('the undo puts the request back by upsert and lifts only a suppression this decline created, only the caller\'s own', async () => {
    const prev = { wineDefinition: 'w1', vintage: '2018', requesters: [{ user: 'u1' }], firstRequestedAt: 'a', lastRequestedAt: 'b', skipCreated: true };
    await ops.restoreDeclinedRequest(prev, 'somm1');
    expect(PriceTrackingRequest.findOneAndUpdate).toHaveBeenCalledWith(
      { wineDefinition: 'w1', vintage: '2018' },
      { $setOnInsert: { wineDefinition: 'w1', vintage: '2018', requesters: [{ user: 'u1' }], firstRequestedAt: 'a', lastRequestedAt: 'b' } },
      { upsert: true });
    expect(PriceTrackingSkip.deleteOne).toHaveBeenCalledWith({ wineDefinition: 'w1', vintage: '2018', skippedBy: 'somm1' });

    jest.clearAllMocks();
    await ops.restoreDeclinedRequest({ ...prev, skipCreated: false }, 'somm1');
    expect(PriceTrackingSkip.deleteOne).not.toHaveBeenCalled();
  });

  test('removing a snapshot is scoped to the caller\'s own', () => {
    ops.removePriceSnapshot({ entryId: 'e1', actorId: 'somm1' });
    expect(WineVintagePrice.deleteOne).toHaveBeenCalledWith({ _id: 'e1', setBy: 'somm1' });
  });
});
