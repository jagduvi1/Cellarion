/**
 * MCP Phase-4 pull tools — list_notifications / mark_notification_read /
 * climate_status invariants.
 *
 * Pins: scope + annotations (mark_read is a mutation for the budget but is
 * deliberately ledger-less — cosmetic UI state), caller-scoped queries (a
 * foreign notification id is indistinguishable from a missing one), and the
 * climate serialization (bounds, online state, in-range verdicts).
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({
  find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/Notification', () => ({
  find: jest.fn(), countDocuments: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(),
}));
jest.mock('../models/ClimateDevice', () => ({ find: jest.fn() }));
jest.mock('../services/climateAlerts', () => ({
  effectiveClimateConfig: jest.fn(() => ({ tempMin: 8, tempMax: 16, rhMin: 50, rhMax: 80, offlineAfterMin: 60 })),
}));
jest.mock('../services/climateHistory', () => ({
  collectClimateHistory: jest.fn(async () => ({ history: null, warnings: [] })),
  formatHistoryCapsule: jest.fn(() => null),
}));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Notification = require('../models/Notification');
const ClimateDevice = require('../models/ClimateDevice');
const { collectClimateHistory, formatHistoryCapsule } = require('../services/climateHistory');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const CTX = { user: { id: ME }, scopes: ['read'] };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe('registration & scopes', () => {
  test('reads are read-scoped; mark_read is a write-scoped idempotent mutation', () => {
    expect(tool('list_notifications').scope).toBe('read');
    expect(tool('climate_status').scope).toBe('read');
    expect(tool('mark_notification_read').scope).toBe('write');
    expect(tool('mark_notification_read').annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false });
    const readNames = toolsForScopes(['read'], ['user']).map((t) => t.name);
    expect(readNames).not.toContain('mark_notification_read');
  });
});

describe('list_notifications', () => {
  test('defaults to unread-only, caller-scoped, newest first', async () => {
    Notification.countDocuments.mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    Notification.find.mockReturnValue(chain([
      { _id: oid('1'), type: 'drink_window_peak', title: 'Peak', message: 'Barolo at peak', read: false, createdAt: new Date() },
    ]));
    const res = await tool('list_notifications').handler({}, CTX);
    const body = parse(res);
    expect(Notification.find).toHaveBeenCalledWith({ user: ME, read: false });
    expect(body.data[0]).toMatchObject({ type: 'drink_window_peak', read: false });
    expect(body.summary).toMatch(/unread/);
  });

  test('unread_only:false lists everything', async () => {
    Notification.countDocuments.mockResolvedValue(0);
    Notification.find.mockReturnValue(chain([]));
    await tool('list_notifications').handler({ unread_only: false }, CTX);
    expect(Notification.find).toHaveBeenCalledWith({ user: ME });
  });
});

describe('mark_notification_read', () => {
  test('single id: caller-scoped update; foreign/missing → not_found (no oracle)', async () => {
    Notification.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    let res = await tool('mark_notification_read').handler({ notification_id: oid('1') }, CTX);
    expect(parse(res).error).toBeUndefined();
    expect(Notification.updateOne).toHaveBeenCalledWith({ _id: oid('1'), user: ME }, { $set: { read: true } });

    Notification.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    res = await tool('mark_notification_read').handler({ notification_id: oid('2') }, CTX);
    expect(parse(res).error.code).toBe('not_found');
  });

  test('all:true marks everything; neither arg → invalid_input', async () => {
    Notification.updateMany.mockResolvedValue({ modifiedCount: 5 });
    let res = await tool('mark_notification_read').handler({ all: true }, CTX);
    expect(parse(res).data.marked).toBe(5);
    expect(Notification.updateMany).toHaveBeenCalledWith({ user: ME, read: false }, { $set: { read: true } });

    res = await tool('mark_notification_read').handler({}, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
  });
});

describe('climate_status', () => {
  const wireCellar = () => Cellar.findById.mockReturnValue(chain({ _id: new mongoose.Types.ObjectId(oid('c')), user: ME, members: [], deletedAt: null, name: 'Main' }));

  test('serializes bounds, online state and in-range verdicts per channel', async () => {
    wireCellar();
    const now = Date.now();
    ClimateDevice.find.mockReturnValue(chain([{
      name: 'ESP32', lastSeenAt: new Date(now - 5 * 60 * 1000),
      channels: [
        { key: 'ambient', type: 'temperature', label: '', lastValue: 12, lastValueAt: new Date(), alertState: 'ok' },
        { key: 'ambient', type: 'humidity', label: '', lastValue: 90, lastValueAt: new Date(), alertState: 'breached' },
      ],
    }]));
    const res = await tool('climate_status').handler({ cellar_id: oid('c') }, CTX);
    const body = parse(res);
    expect(body.data.bounds.temperature).toEqual({ min: 8, max: 16, unit: '°C' });
    const [temp, rh] = body.data.devices[0].channels;
    expect(body.data.devices[0].online).toBe(true);
    expect(temp.in_range).toBe(true);
    expect(rh.in_range).toBe(false);       // 90 > rhMax 80
    expect(rh.alert_state).toBe('breached');
    expect(body.summary).toMatch(/OUT OF RANGE/);
  });

  test('offline device flagged; sensorless cellar answers gracefully; foreign cellar → not_found', async () => {
    wireCellar();
    ClimateDevice.find.mockReturnValue(chain([{
      name: 'Silent', lastSeenAt: new Date(Date.now() - 3 * 3600 * 1000), channels: [],
    }]));
    let res = await tool('climate_status').handler({ cellar_id: oid('c') }, CTX);
    expect(parse(res).data.devices[0].online).toBe(false);
    expect(parse(res).summary).toMatch(/1 offline/);

    wireCellar();
    ClimateDevice.find.mockReturnValue(chain([]));
    collectClimateHistory.mockClear();
    res = await tool('climate_status').handler({ cellar_id: oid('c') }, CTX);
    expect(parse(res).warnings.join(' ')).toMatch(/no climate devices/i);
    // No sensors → no readings query at all.
    expect(collectClimateHistory).not.toHaveBeenCalled();

    Cellar.findById.mockReturnValue(chain(null));
    res = await tool('climate_status').handler({ cellar_id: oid('9') }, CTX);
    expect(parse(res).error.code).toBe('not_found');
  });

  test('history aggregates ride along per device set, the capsule joins the summary, and warnings pass through', async () => {
    // Ticket 6a71c6b2: the aggregates (24h/30d/12m min/max/mean + excursions)
    // are climate_status's answer to "what temperature has this cellar been
    // stored at" — a separate history tool was deliberately not built.
    const history = {
      temperature: {
        unit: '°C',
        '24h': { readings: 288, min: 12.1, max: 13.9, mean: 12.9, out_of_range: 0, excursions: 0, longest_excursion_minutes: null },
        '30d': { readings: 8640, min: 11.5, max: 17.4, mean: 13, out_of_range: 20, excursions: 1, longest_excursion_minutes: 100 },
        '12m': { readings: 99000, min: 10.2, max: 18.3, mean: 13, out_of_range: 21, excursions: 2, longest_excursion_minutes: 100 },
      },
      humidity: null,
    };
    collectClimateHistory.mockResolvedValueOnce({ history, warnings: ['partial data'] });
    formatHistoryCapsule.mockReturnValueOnce('12m: 10.2–18.3 °C, 2 excursion(s), longest 1.7 h');

    wireCellar();
    const deviceId = new mongoose.Types.ObjectId(oid('d'));
    ClimateDevice.find.mockReturnValue(chain([{
      _id: deviceId, name: 'ESP32', lastSeenAt: new Date(),
      channels: [{ key: 'ambient', type: 'temperature', label: '', lastValue: 12, lastValueAt: new Date(), alertState: 'ok' }],
    }]));

    const res = await tool('climate_status').handler({ cellar_id: oid('c') }, CTX);
    const body = parse(res);
    expect(collectClimateHistory).toHaveBeenCalledWith({
      deviceIds: [deviceId],
      cfg: expect.objectContaining({ tempMin: 8, tempMax: 16 }),
      now: expect.any(Date),
    });
    expect(body.data.history).toEqual(JSON.parse(JSON.stringify(history)));
    expect(body.summary).toMatch(/12m: 10\.2–18\.3 °C, 2 excursion\(s\)/);
    expect(body.warnings).toEqual(['partial data']);
  });

  test('the tool description advertises the aggregate windows to AI callers', () => {
    expect(tool('climate_status').description).toMatch(/24h \/ 30d \/ 12m/);
    expect(tool('climate_status').description).not.toMatch(/Historical charts are web-app-only/);
  });
});
