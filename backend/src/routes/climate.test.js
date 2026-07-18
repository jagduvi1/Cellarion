/**
 * /api/climate routes (docs/climate-monitoring.md).
 *
 * WHY THIS TEST EXISTS:
 * Ingest is a PUBLIC, documented contract authenticated by device tokens —
 * it must (a) reject JWT sessions (device identity comes from the token),
 * (b) validate every reading (bounds, timestamps, channel keys) while
 * accepting the valid remainder, (c) auto-register channels up to the cap,
 * and (d) apply calibration at write time. Device management mints durable
 * credentials (password-confirmed, capped) and must clean up tokens +
 * readings on delete. Cellar reads are role-gated; config is owner-only.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn(async () => {}) }));
jest.mock('../services/eventBus', () => ({ emit: jest.fn(), dropToken: jest.fn() }));
jest.mock('../config/rateLimits', () => ({
  get: () => ({ auth: { max: 1000 }, api: { max: 1000 }, write: { max: 1000 } }),
}));
jest.mock('../utils/cellarAccess', () => ({ getCellarRole: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/ApiToken', () => {
  const crypto = require('crypto');
  return {
    findOne: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(async () => {}),
    deleteOne: jest.fn(() => ({ catch: () => {} })),
    hashToken: (raw) => crypto.createHash('sha256').update(raw).digest('hex'),
    generateToken: () => 'cel_' + crypto.randomBytes(32).toString('hex'),
    TOKEN_PREFIX: 'cel_',
    TOKEN_SCOPES: ['read', 'consume', 'climate'],
    MAX_ACTIVE_TOKENS_PER_USER: 10,
  };
});
jest.mock('../models/Cellar', () => ({
  findOne: jest.fn(),
  CLIMATE_DEFAULTS: Object.freeze({
    tempMin: 8, tempMax: 16, rhMin: 45, rhMax: 80, offlineAfterMin: 60, alertsEnabled: true,
  }),
}));
jest.mock('../models/ClimateDevice', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  READING_TYPES: ['temperature', 'humidity'],
  MAX_CHANNELS_PER_DEVICE: 16,
  MAX_DEVICES_PER_USER: 5,
  CHANNEL_KEY_RE: /^[a-z0-9][a-z0-9_-]{0,63}$/i,
}));
jest.mock('../models/ClimateReading', () => ({
  insertMany: jest.fn(async () => {}),
  deleteMany: jest.fn(async () => {}),
  find: jest.fn(),
  aggregate: jest.fn(async () => []),
}));
// Route-focused tests: requireAuth is simplified here. The real token path
// (scope allowlist, default-deny) is pinned by middleware/apiTokenAuth.test.js.
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'No token provided' });
    req.user = { id: 'u1', roles: ['user'], plan: 'free', planExpiresAt: null };
    if (req.headers['x-api-token']) req.apiToken = { id: 'tok1', scopes: ['climate'] };
    next();
  },
}));

const express = require('express');
const http = require('http');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');
const Cellar = require('../models/Cellar');
const ClimateDevice = require('../models/ClimateDevice');
const ClimateReading = require('../models/ClimateReading');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const eventBus = require('../services/eventBus');
const climateRouter = require('./climate');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/climate', climateRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});
beforeEach(() => jest.clearAllMocks());

const OID = 'a'.repeat(24);
const OID2 = 'b'.repeat(24);

const request = (method, path, body, headers = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
const deviceRequest = (body) => request('POST', '/api/climate/ingest', body, { 'x-api-token': '1' });

// A ClimateDevice doc double with the schema method the route relies on.
const fakeDevice = (over = {}) => ({
  _id: OID,
  user: 'u1',
  cellar: null,
  name: 'Cellar ESP32',
  token: 'tok1',
  channels: [],
  firmware: '',
  lastSeenAt: null,
  lastRssi: null,
  offlineNotifiedAt: null,
  dailyReadingCount: 0,
  dailyReadingDate: null,
  createdAt: new Date(),
  save: jest.fn(async () => {}),
  deleteOne: jest.fn(async () => {}),
  findChannel(key, type) { return this.channels.find(c => c.key === key && c.type === type); },
  ...over,
});

// Chainable query double: find(...).sort().populate().select().lean() etc.,
// awaitable at any depth.
const chain = (result) => {
  const c = {
    sort: () => c, populate: () => c, select: () => c,
    lean: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return c;
};

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/climate/ingest', () => {
  test('rejects without auth', async () => {
    const res = await fetch(`${baseUrl}/api/climate/ingest`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('rejects JWT sessions — ingest is device-token only', async () => {
    const res = await request('POST', '/api/climate/ingest', { readings: [] });
    expect(res.status).toBe(403);
  });

  test('token with no bound device → 404', async () => {
    ClimateDevice.findOne.mockResolvedValue(null);
    const res = await deviceRequest({ readings: [{ channel: 'a', type: 'temperature', value: 12 }] });
    expect(res.status).toBe(404);
    expect(ClimateDevice.findOne).toHaveBeenCalledWith({ token: 'tok1' });
  });

  test.each([
    [undefined],
    [{ readings: [] }],
    [{ readings: 'nope' }],
    [{ readings: Array.from({ length: 101 }, () => ({ channel: 'a', type: 'temperature', value: 1 })) }],
  ])('malformed readings envelope → 400 (%#)', async (body) => {
    ClimateDevice.findOne.mockResolvedValue(fakeDevice());
    const res = await deviceRequest(body);
    expect(res.status).toBe(400);
  });

  test('happy path: stores readings, auto-registers channels, caches last values, nudges SSE', async () => {
    const device = fakeDevice();
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await deviceRequest({
      firmware: 'esphome 2026.6.0',
      rssi: -61,
      readings: [
        { channel: 'ambient', type: 'temperature', value: 12.4 },
        { channel: 'ambient', type: 'humidity', value: 68 },
      ],
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(0);
    expect(body.intervalS).toBeGreaterThanOrEqual(60);

    const docs = ClimateReading.insertMany.mock.calls[0][0];
    expect(docs).toHaveLength(2);
    expect(docs[0].meta).toEqual({ device: OID, channel: 'ambient', type: 'temperature' });
    expect(docs[0].value).toBe(12.4);

    // (key,type) channels auto-registered, last values cached
    expect(device.channels).toHaveLength(2);
    const temp = device.findChannel('ambient', 'temperature');
    expect(temp.lastValue).toBe(12.4);
    expect(temp.lastValueAt).toBeInstanceOf(Date);
    expect(device.firmware).toBe('esphome 2026.6.0');
    expect(device.lastRssi).toBe(-61);
    expect(device.lastSeenAt).toBeInstanceOf(Date);
    // Persisted atomically (not save()) — $inc the day counter, $set the caches.
    const [filter, update] = ClimateDevice.updateOne.mock.calls.at(-1);
    expect(filter).toEqual({ _id: OID });
    expect(update.$inc).toEqual({ dailyReadingCount: 2 });
    expect(update.$set.lastSeenAt).toBeInstanceOf(Date);
    expect(device.save).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith('u1', 'climate', { device: OID });
  });

  test('calibration offset is applied at write time', async () => {
    const device = fakeDevice({
      channels: [{ key: 'probe-a', type: 'temperature', calibrationOffset: 0.5, lastValue: null, lastValueAt: null, alertState: 'ok', breachedSince: null, lastAlertAt: null }],
    });
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await deviceRequest({ readings: [{ channel: 'probe-a', type: 'temperature', value: 12.5 }] });
    expect(res.status).toBe(202);
    expect(ClimateReading.insertMany.mock.calls[0][0][0].value).toBe(13);
    expect(device.channels[0].lastValue).toBe(13);
  });

  test('per-reading validation rejects bad entries but accepts the rest', async () => {
    const device = fakeDevice();
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await deviceRequest({
      readings: [
        { channel: 'ok', type: 'temperature', value: 12 },
        { channel: 'bad channel!', type: 'temperature', value: 12 },  // invalid_channel
        { channel: 'ok', type: 'pressure', value: 12 },               // invalid_type
        { channel: 'ok', type: 'temperature', value: 'warm' },        // invalid_value
        { channel: 'ok', type: 'temperature', value: 99 },            // out_of_bounds
        { channel: 'ok', type: 'temperature', value: 12, ts: 'garbage' },                                // invalid_ts
        { channel: 'ok', type: 'temperature', value: 12, ts: new Date(Date.now() - 49 * 3600e3) },       // ts_too_old
        { channel: 'ok', type: 'temperature', value: 12, ts: new Date(Date.now() + 10 * 60e3) },         // ts_in_future
      ],
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(7);
    expect(body.errors.map(e => e.reason)).toEqual([
      'invalid_channel', 'invalid_type', 'invalid_value', 'out_of_bounds', 'invalid_ts', 'ts_too_old', 'ts_in_future',
    ]);
  });

  test('channel auto-registration stops at the cap', async () => {
    const device = fakeDevice({
      channels: Array.from({ length: 16 }, (_, i) => ({ key: `c${i}`, type: 'temperature', calibrationOffset: 0, lastValue: null, lastValueAt: null, alertState: 'ok', breachedSince: null, lastAlertAt: null })),
    });
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await deviceRequest({ readings: [{ channel: 'one-too-many', type: 'temperature', value: 12 }] });
    const body = await res.json();
    expect(body.accepted).toBe(0);
    expect(body.errors[0].reason).toBe('channel_limit');
    expect(device.channels).toHaveLength(16);
  });

  test('a device coming back from a notified silence sends climate_recovered and clears the flag', async () => {
    const device = fakeDevice({ offlineNotifiedAt: new Date() });
    ClimateDevice.findOne.mockResolvedValue(device);

    await deviceRequest({ readings: [{ channel: 'a', type: 'temperature', value: 12 }] });
    expect(device.offlineNotifiedAt).toBeNull();
    expect(createNotification).toHaveBeenCalledWith('u1', 'climate_recovered', expect.stringContaining('back online'), expect.any(String), '/settings');
  });

  test('daily quota: an exhausted device gets 429, liveness still updates, nothing inserted', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const device = fakeDevice({ dailyReadingCount: 20000, dailyReadingDate: today });
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await deviceRequest({ readings: [{ channel: 'a', type: 'temperature', value: 12 }] });
    expect(res.status).toBe(429);
    expect(ClimateReading.insertMany).not.toHaveBeenCalled();
    // Quota-blocked is not offline — lastSeenAt still advances, via an atomic
    // $set (never save() that a concurrent post could clobber).
    const [filter, update] = ClimateDevice.updateOne.mock.calls.at(-1);
    expect(filter).toEqual({ _id: OID });
    expect(update.$set.lastSeenAt).toBeInstanceOf(Date);
    expect(device.save).not.toHaveBeenCalled();
  });

  test('daily quota: overflow within one batch is trimmed and reported as daily_quota', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const device = fakeDevice({ dailyReadingCount: 19999, dailyReadingDate: today });
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await deviceRequest({
      readings: [
        { channel: 'a', type: 'temperature', value: 12 },
        { channel: 'b', type: 'temperature', value: 13 },
        { channel: 'c', type: 'temperature', value: 14 },
      ],
    });
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(2);
    expect(body.errors.map(e => e.reason)).toEqual(['daily_quota', 'daily_quota']);
    expect(ClimateReading.insertMany.mock.calls[0][0]).toHaveLength(1);
    // Only the granted reading is counted, via an atomic $inc.
    const persist = ClimateDevice.updateOne.mock.calls.at(-1);
    expect(persist[1].$inc).toEqual({ dailyReadingCount: 1 });
  });

  test('daily quota resets on a new UTC day', async () => {
    const device = fakeDevice({ dailyReadingCount: 20000, dailyReadingDate: '2020-01-01' });
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await deviceRequest({ readings: [{ channel: 'a', type: 'temperature', value: 12 }] });
    expect(res.status).toBe(202);
    expect((await res.json()).accepted).toBe(1);
    const today = new Date().toISOString().slice(0, 10);
    // The stale day is rolled over atomically (conditional reset) before the $inc.
    const rollover = ClimateDevice.updateOne.mock.calls.find(
      c => c[0].dailyReadingDate && c[0].dailyReadingDate.$ne === today
    );
    expect(rollover).toBeTruthy();
    expect(rollover[1].$set).toEqual({ dailyReadingDate: today, dailyReadingCount: 0 });
    const persist = ClimateDevice.updateOne.mock.calls.at(-1);
    expect(persist[1].$inc).toEqual({ dailyReadingCount: 1 });
  });

  test('an out-of-bounds reading on a new channel does NOT register a phantom channel', async () => {
    const device = fakeDevice();
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await deviceRequest({ readings: [{ channel: 'ghost', type: 'temperature', value: -127 }] });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(0);
    expect(body.errors[0].reason).toBe('out_of_bounds');
    // The rejected reading must leave no trace: no channel, no insert.
    expect(device.channels).toHaveLength(0);
    expect(ClimateReading.insertMany).not.toHaveBeenCalled();
    const persist = ClimateDevice.updateOne.mock.calls.at(-1);
    expect(persist[1].$set.channels).toHaveLength(0);
    expect(persist[1].$inc).toEqual({ dailyReadingCount: 0 });
  });

  test('a quota-trimmed reading does NOT update the last-value cache (no phantom "current" value)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const device = fakeDevice({
      dailyReadingCount: 20000, // exhausted → quotaRemaining 0
      dailyReadingDate: today,
      channels: [{ key: 'ambient', type: 'temperature', calibrationOffset: 0, label: '', lastValue: 12, lastValueAt: new Date(Date.now() - 3600e3), alertState: 'ok', breachedSince: null, lastAlertAt: null }],
    });
    ClimateDevice.findOne.mockResolvedValue(device);

    // Exhausted → 429, and the out-of-range value 40 never becomes "current".
    const res = await deviceRequest({ readings: [{ channel: 'ambient', type: 'temperature', value: 40 }] });
    expect(res.status).toBe(429);
    expect(device.channels[0].lastValue).toBe(12); // unchanged
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a sustained threshold breach on an assigned cellar notifies climate_alert', async () => {
    const sixteenMinAgo = new Date(Date.now() - 16 * 60 * 1000);
    const device = fakeDevice({
      cellar: OID2,
      channels: [{ key: 'ambient', type: 'temperature', calibrationOffset: 0, label: '', lastValue: null, lastValueAt: null, alertState: 'ok', breachedSince: sixteenMinAgo, lastAlertAt: null }],
    });
    ClimateDevice.findOne.mockResolvedValue(device);
    Cellar.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: OID2, name: 'Main', user: 'u1', climate: { tempMin: 8, tempMax: 16 } }) });

    await deviceRequest({ readings: [{ channel: 'ambient', type: 'temperature', value: 19 }] });

    expect(createNotification).toHaveBeenCalledWith(
      'u1', 'climate_alert', expect.stringContaining('Main'), expect.stringContaining('19'), `/cellars/${OID2}`
    );
    expect(device.channels[0].alertState).toBe('breached');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/climate/devices', () => {
  const validBody = { name: 'Cellar ESP32', password: 'pw' };

  test.each([
    [{ password: 'pw' }],
    [{ name: '', password: 'pw' }],
    [{ name: 'x'.repeat(101), password: 'pw' }],
    [{ name: 'ok' }],
  ])('validates input → 400 (%#)', async (body) => {
    const res = await request('POST', '/api/climate/devices', body);
    expect(res.status).toBe(400);
  });

  test('wrong password → 403 + audit, nothing created', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', password: 'bcrypt-hash', comparePassword: jest.fn().mockResolvedValue(false) });
    const res = await request('POST', '/api/climate/devices', validBody);
    expect(res.status).toBe(403);
    expect(ApiToken.create).not.toHaveBeenCalled();
    expect(ClimateDevice.create).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'climate.device.create_failed', expect.anything(), { reason: 'incorrect_password' });
  });

  test('SSO-only account (no password) → 403 with code no_password, nothing created', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', comparePassword: jest.fn().mockResolvedValue(false) });
    const res = await request('POST', '/api/climate/devices', validBody);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('no_password');
    expect(ApiToken.create).not.toHaveBeenCalled();
    expect(ClimateDevice.create).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'climate.device.create_failed', expect.anything(), { reason: 'no_password' });
  });

  test('device cap → 400', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', password: 'bcrypt-hash', comparePassword: jest.fn().mockResolvedValue(true) });
    ClimateDevice.countDocuments.mockResolvedValue(5);
    const res = await request('POST', '/api/climate/devices', validBody);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('devices');
  });

  test('active-token cap → 400 (each device consumes a token slot)', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', password: 'bcrypt-hash', comparePassword: jest.fn().mockResolvedValue(true) });
    ClimateDevice.countDocuments.mockResolvedValue(0);
    ApiToken.countDocuments.mockResolvedValue(10);
    const res = await request('POST', '/api/climate/devices', validBody);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('token');
  });

  test('happy path mints a climate-scoped token (shown once) and creates the device', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', password: 'bcrypt-hash', comparePassword: jest.fn().mockResolvedValue(true) });
    ClimateDevice.countDocuments.mockResolvedValue(0);
    ApiToken.countDocuments.mockResolvedValue(0);
    ApiToken.create.mockImplementation(async (doc) => ({ ...doc, _id: 'tok9' }));
    ClimateDevice.create.mockImplementation(async (doc) => fakeDevice({ ...doc, _id: OID }));

    const res = await request('POST', '/api/climate/devices', validBody);
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.token).toMatch(/^cel_[0-9a-f]{64}$/);
    expect(body.device.name).toBe('Cellar ESP32');

    const storedToken = ApiToken.create.mock.calls[0][0];
    expect(storedToken.scopes).toEqual(['climate']);
    expect(storedToken.tokenHash).toBe(ApiToken.hashToken(body.token));
    expect(JSON.stringify(storedToken)).not.toContain(body.token);

    const storedDevice = ClimateDevice.create.mock.calls[0][0];
    expect(storedDevice).toMatchObject({ user: 'u1', name: 'Cellar ESP32', token: 'tok9', cellar: null });

    const auditJson = JSON.stringify(logAudit.mock.calls.map(c => c.slice(1)));
    expect(auditJson).toContain('climate.device.created');
    expect(auditJson).not.toContain(body.token);
  });

  test('cellar assignment requires owner/editor role', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', password: 'bcrypt-hash', comparePassword: jest.fn().mockResolvedValue(true) });
    ClimateDevice.countDocuments.mockResolvedValue(0);
    ApiToken.countDocuments.mockResolvedValue(0);
    Cellar.findOne.mockResolvedValue({ _id: OID2, user: 'other' });
    getCellarRole.mockReturnValue('viewer');

    const res = await request('POST', '/api/climate/devices', { ...validBody, cellarId: OID2 });
    expect(res.status).toBe(400);
    expect(ApiToken.create).not.toHaveBeenCalled();
  });

  test('a failed device insert never leaves an orphaned live token', async () => {
    User.findById.mockResolvedValue({ _id: 'u1', password: 'bcrypt-hash', comparePassword: jest.fn().mockResolvedValue(true) });
    ClimateDevice.countDocuments.mockResolvedValue(0);
    ApiToken.countDocuments.mockResolvedValue(0);
    ApiToken.create.mockImplementation(async (doc) => ({ ...doc, _id: 'tok9' }));
    ClimateDevice.create.mockRejectedValue(new Error('boom'));

    const res = await request('POST', '/api/climate/devices', validBody);
    expect(res.status).toBe(500);
    expect(ApiToken.deleteOne).toHaveBeenCalledWith({ _id: 'tok9' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('device list/update/delete', () => {
  test('GET /devices returns the caller’s devices with channels and cellar', async () => {
    const d = fakeDevice({ cellar: { _id: OID2, name: 'Main' }, token: { lastUsedAt: null }, channels: [{ key: 'a', type: 'temperature', label: '', calibrationOffset: 0, lastValue: 12, lastValueAt: new Date(), alertState: 'ok' }] });
    ClimateDevice.find.mockReturnValue(chain([d]));

    const res = await request('GET', '/api/climate/devices');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxDevices).toBe(5);
    expect(body.devices[0]).toMatchObject({
      name: 'Cellar ESP32',
      cellar: { name: 'Main' },
      channels: [{ key: 'a', type: 'temperature', lastValue: 12 }],
    });
  });

  test('PUT /devices/:id edits channel labels/offsets, rejects unknown channels', async () => {
    const device = fakeDevice({
      channels: [{ key: 'a', type: 'temperature', label: '', calibrationOffset: 0, lastValue: null, lastValueAt: null, alertState: 'ok', breachedSince: null, lastAlertAt: null }],
    });
    ClimateDevice.findOne.mockResolvedValue(device);

    const bad = await request('PUT', `/api/climate/devices/${OID}`, { channels: [{ key: 'nope', type: 'temperature', label: 'X' }] });
    expect(bad.status).toBe(400);

    const res = await request('PUT', `/api/climate/devices/${OID}`, {
      name: 'Renamed',
      channels: [{ key: 'a', type: 'temperature', label: 'Top shelf', calibrationOffset: -0.5 }],
    });
    expect(res.status).toBe(200);
    expect(device.name).toBe('Renamed');
    expect(device.channels[0].label).toBe('Top shelf');
    expect(device.channels[0].calibrationOffset).toBe(-0.5);
    expect(device.save).toHaveBeenCalled();
  });

  test("PUT on someone else's device → 404 (owner-scoped findOne)", async () => {
    ClimateDevice.findOne.mockResolvedValue(null);
    const res = await request('PUT', `/api/climate/devices/${OID}`, { name: 'X' });
    expect(res.status).toBe(404);
    expect(ClimateDevice.findOne).toHaveBeenCalledWith({ _id: OID, user: 'u1' });
  });

  test('DELETE revokes the token, drops readings, removes the device, audits', async () => {
    const device = fakeDevice();
    ClimateDevice.findOne.mockResolvedValue(device);

    const res = await request('DELETE', `/api/climate/devices/${OID}`);
    expect(res.status).toBe(200);
    expect(ApiToken.updateOne).toHaveBeenCalledWith({ _id: 'tok1' }, { $set: { revokedAt: expect.any(Date) } });
    expect(eventBus.dropToken).toHaveBeenCalledWith('tok1');
    expect(ClimateReading.deleteMany).toHaveBeenCalledWith({ 'meta.device': OID });
    expect(device.deleteOne).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'climate.device.deleted', expect.anything(), { name: 'Cellar ESP32' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cellar-facing reads + config', () => {
  const cellarDoc = (over = {}) => ({ _id: OID2, name: 'Main', user: 'u1', climate: undefined, save: jest.fn(async () => {}), ...over });

  test('GET current: 404 without a cellar role', async () => {
    Cellar.findOne.mockResolvedValue(cellarDoc());
    getCellarRole.mockReturnValue(null);
    const res = await request('GET', `/api/climate/cellars/${OID2}/current`);
    expect(res.status).toBe(404);
  });

  test('GET current returns config defaults, devices, and online state', async () => {
    Cellar.findOne.mockResolvedValue(cellarDoc());
    getCellarRole.mockReturnValue('viewer');
    ClimateDevice.find.mockReturnValue(chain([
      { ...fakeDevice({ lastSeenAt: new Date() }), save: undefined },
      { ...fakeDevice({ _id: OID, name: 'Old', lastSeenAt: new Date(Date.now() - 2 * 3600e3) }), save: undefined },
    ]));

    const res = await request('GET', `/api/climate/cellars/${OID2}/current`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config).toMatchObject({ tempMin: 8, tempMax: 16, offlineAfterMin: 60 });
    expect(body.isOwner).toBe(true);
    expect(body.devices).toHaveLength(2);
    expect(body.devices[0].online).toBe(true);   // just posted
    expect(body.devices[1].online).toBe(false);  // silent 2 h > offlineAfterMin 60
  });

  test('GET readings buckets by range and reshapes into per-channel series', async () => {
    Cellar.findOne.mockResolvedValue(cellarDoc());
    getCellarRole.mockReturnValue('viewer');
    ClimateDevice.find.mockReturnValue(chain([{ _id: { toString: () => OID }, name: 'ESP' }]));
    const t1 = new Date('2026-07-10T10:00:00Z');
    const t2 = new Date('2026-07-10T10:05:00Z');
    ClimateReading.aggregate.mockResolvedValue([
      { _id: { device: { toString: () => OID }, channel: 'ambient', type: 'temperature', t: t1 }, min: 12, max: 12.6, avg: 12.3 },
      { _id: { device: { toString: () => OID }, channel: 'ambient', type: 'temperature', t: t2 }, min: 12.2, max: 12.8, avg: 12.5 },
    ]);

    const res = await request('GET', `/api/climate/cellars/${OID2}/readings?range=24h`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bucketMinutes).toBe(5);
    expect(body.series).toHaveLength(1);
    expect(body.series[0]).toMatchObject({ channel: 'ambient', type: 'temperature', deviceName: 'ESP' });
    expect(body.series[0].points).toHaveLength(2);

    const pipeline = ClimateReading.aggregate.mock.calls[0][0];
    expect(pipeline[1].$group._id.t.$dateTrunc.binSize).toBe(5);
  });

  test('PUT config is owner-scoped, validates ranges, persists and audits', async () => {
    const cellar = cellarDoc();
    Cellar.findOne.mockResolvedValue(cellar);

    const bad = await request('PUT', `/api/climate/cellars/${OID2}/config`, { tempMin: 20, tempMax: 10 });
    expect(bad.status).toBe(400);

    const res = await request('PUT', `/api/climate/cellars/${OID2}/config`, { tempMin: 10, tempMax: 14, alertsEnabled: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config).toMatchObject({ tempMin: 10, tempMax: 14, rhMin: 45, alertsEnabled: false });
    expect(cellar.climate).toMatchObject({ tempMin: 10, tempMax: 14 });
    expect(cellar.save).toHaveBeenCalled();
    // Owner-scoped findOne — members must 404
    expect(Cellar.findOne).toHaveBeenCalledWith({ _id: OID2, user: 'u1', deletedAt: null });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'climate.config.updated', expect.anything(), expect.objectContaining({ tempMin: 10 }));
  });

  test('PUT config rejects out-of-range numbers', async () => {
    Cellar.findOne.mockResolvedValue(cellarDoc());
    const res = await request('PUT', `/api/climate/cellars/${OID2}/config`, { offlineAfterMin: 5 });
    expect(res.status).toBe(400);
  });
});
