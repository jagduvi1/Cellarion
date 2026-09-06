/**
 * Registry lockdown L4 — the daily readers report: rank by distinct wines,
 * alert admins only past the level for the reader's kind.
 */
jest.mock('../models/RegistryReadDay', () => ({ aggregate: jest.fn() }));
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('./notifications', () => ({ createNotifications: jest.fn(async () => {}) }));
jest.mock('../config/rateLimits', () => ({ get: jest.fn(() => ({ registryRead: { anonymousDailyDistinct: 300, memberAlertDistinct: 1000 } })) }));

const RegistryReadDay = require('../models/RegistryReadDay');
const User = require('../models/User');
const { createNotifications } = require('./notifications');
const { runRegistryReadReport } = require('./registryReadReportJob');

const row = (readerKey, kind, distinct, count, blocked = false) => ({ readerKey, kind, distinct, count, blockedAt: blocked ? new Date() : null });

beforeEach(() => {
  jest.clearAllMocks();
  User.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'admin1' }, { _id: 'admin2' }] }) });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); });

test('a quiet day: logged, nobody notified', async () => {
  RegistryReadDay.aggregate.mockResolvedValue([row('ip:1', 'ip', 12, 30), row('user:u1', 'user', 40, 80)]);
  const out = await runRegistryReadReport('2026-09-05');
  expect(out.alerted).toEqual([]);
  expect(createNotifications).not.toHaveBeenCalled();
  expect(RegistryReadDay.aggregate.mock.calls[0][0][0]).toEqual({ $match: { day: '2026-09-05' } });
});

test('an address past the anonymous cap and a member past the alert level are reported to every admin', async () => {
  RegistryReadDay.aggregate.mockResolvedValue([
    row('ip:scraper', 'ip', 2400, 2600, true),
    row('user:heavy', 'user', 1200, 1300),
    row('user:normal', 'user', 500, 900),   // over the anonymous cap but under the member level — fine
  ]);
  const out = await runRegistryReadReport('2026-09-05');
  expect(out.alerted.map((r) => r.readerKey)).toEqual(['ip:scraper', 'user:heavy']);
  expect(createNotifications).toHaveBeenCalledTimes(1);
  const items = createNotifications.mock.calls[0][0];
  expect(items.map((i) => i.userId)).toEqual(['admin1', 'admin2']);
  expect(items[0].type).toBe('registry_read_alert');
  expect(items[0].message).toContain('ip:scraper (ip) 2400 distinct wines, 2600 reads, refused');
  expect(items[0].message).toContain('user:heavy (user) 1200 distinct wines');
  expect(items[0].message).not.toContain('user:normal');
});

test('defaults to yesterday (UTC)', async () => {
  RegistryReadDay.aggregate.mockResolvedValue([]);
  const out = await runRegistryReadReport();
  const expected = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  expect(out.day).toBe(expected);
});
