/**
 * Registry lockdown L4 — the distinct-wines-per-reader counter and the
 * anonymous daily cap. Members are counted, never refused.
 */
// The counter only writes when Mongo is connected (a disconnected model would
// buffer until Mongoose's timeout and stall the wine page); pretend it is.
jest.mock('mongoose', () => ({ connection: { readyState: 1 } }));
jest.mock('../models/RegistryReadDay', () => ({
  RETENTION_DAYS: 14,
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(async () => ({})),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../config/rateLimits', () => ({ get: jest.fn(() => ({ registryRead: { anonymousDailyDistinct: 3, memberAlertDistinct: 10 } })) }));

const RegistryReadDay = require('../models/RegistryReadDay');
const { logAudit } = require('../services/audit');
const { recordRead, gateAnonymousRead, readerFor, readerForMcp } = require('./registryReadTracker');

const lean = (row) => ({ lean: async () => row });
const req = (over = {}) => ({ ip: '203.0.113.9', headers: {}, ...over });

beforeEach(() => { jest.clearAllMocks(); });

describe('readerFor', () => {
  test('a signed-in user is keyed by id, an anonymous request by masked address', () => {
    expect(readerFor(req({ user: { id: 'u1' } }))).toEqual({ key: 'user:u1', kind: 'user' });
    const anon = readerFor(req());
    expect(anon.kind).toBe('ip');
    expect(anon.key.startsWith('ip:')).toBe(true);
  });
  test('an MCP context keys the same way from its request snapshot', () => {
    expect(readerForMcp({ user: { id: 'u1' } })).toEqual({ key: 'user:u1', kind: 'user' });
    expect(readerForMcp({ user: null, req: { ip: '198.51.100.4' } })).toEqual({ key: 'ip:198.51.100.4', kind: 'ip' });
  });
});

describe('recordRead', () => {
  test('upserts today\'s row with $addToSet and reports the distinct count', async () => {
    RegistryReadDay.findOneAndUpdate.mockReturnValue(lean({ wines: ['a', 'b'], count: 5, blockedAt: null }));
    const out = await recordRead({ key: 'ip:x', kind: 'ip' }, 'b');
    expect(out).toEqual({ distinct: 2, count: 5, blockedAt: null });
    const [filter, update, opts] = RegistryReadDay.findOneAndUpdate.mock.calls[0];
    expect(filter.readerKey).toBe('ip:x');
    expect(filter.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(update.$addToSet).toEqual({ wines: 'b' });
    expect(update.$inc).toEqual({ count: 1 });
    expect(update.$setOnInsert.kind).toBe('ip');
    expect(update.$setOnInsert.expiresAt).toBeInstanceOf(Date);
    expect(opts.upsert).toBe(true);
  });
  test('a failing counter never throws — the wine page must not break', async () => {
    RegistryReadDay.findOneAndUpdate.mockImplementation(() => { throw new Error('db down'); });
    await expect(recordRead({ key: 'ip:x', kind: 'ip' }, 'a')).resolves.toBeNull();
  });
});

describe('gateAnonymousRead', () => {
  test('under the cap: allowed', async () => {
    RegistryReadDay.findOneAndUpdate.mockReturnValue(lean({ wines: ['a', 'b', 'c'], count: 3, blockedAt: null }));
    expect(await gateAnonymousRead(req(), 'c')).toEqual({ allowed: true, distinct: 3 });
    expect(logAudit).not.toHaveBeenCalled();
  });
  test('over the cap: refused, audited once, then silently refused', async () => {
    RegistryReadDay.findOneAndUpdate.mockReturnValue(lean({ wines: ['a', 'b', 'c', 'd'], count: 4, blockedAt: null }));
    expect(await gateAnonymousRead(req(), 'd')).toEqual({ allowed: false, distinct: 4 });
    expect(RegistryReadDay.updateOne).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'system.registry_read_cap', {}, expect.objectContaining({ distinct: 4, cap: 3 }));
    RegistryReadDay.findOneAndUpdate.mockReturnValue(lean({ wines: ['a', 'b', 'c', 'd', 'e'], count: 5, blockedAt: new Date() }));
    expect(await gateAnonymousRead(req(), 'e')).toEqual({ allowed: false, distinct: 5 });
    expect(logAudit).toHaveBeenCalledTimes(1);
  });
  test('a member over the cap is counted but never refused', async () => {
    RegistryReadDay.findOneAndUpdate.mockReturnValue(lean({ wines: Array.from({ length: 50 }, (_, i) => String(i)), count: 50, blockedAt: null }));
    expect(await gateAnonymousRead(req({ user: { id: 'u1' } }), 'x')).toEqual({ allowed: true, distinct: 50 });
    expect(logAudit).not.toHaveBeenCalled();
  });
  test('a failing counter fails open', async () => {
    RegistryReadDay.findOneAndUpdate.mockImplementation(() => { throw new Error('db down'); });
    expect(await gateAnonymousRead(req(), 'a')).toEqual({ allowed: true, distinct: 0 });
  });
});
