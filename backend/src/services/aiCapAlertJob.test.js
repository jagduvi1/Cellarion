/**
 * services/aiCapAlertJob: the early warning before the site-wide daily AI cap.
 *
 * WHY THIS TEST EXISTS:
 * At the cap every AI feature switches off for everyone until 00:00 UTC, and
 * until 2026-09-27 nobody heard about it before users did. The warning must
 * come once per threshold (50%, 80%, 100%) per day, never twice (the claim is
 * one conditional update on the day's global row), name only the highest
 * threshold when several were crossed between two runs, and try again on the
 * next run when the email could not be sent.
 */

const mockState = { emailEnabled: true };

jest.mock('../models/AiUsage', () => {
  const rows = []; // { userId, date, count, alertedPct? }
  const matches = (row, filter) => Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$ne' in cond) return value !== cond.$ne;
      if ('$gt' in cond) return value > cond.$gt;
      if ('$not' in cond) return !(value !== undefined && value >= cond.$not.$gte);
      throw new Error(`unsupported filter ${JSON.stringify(cond)}`);
    }
    return value === cond;
  });
  const chain = (result) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => result() });
  return {
    __rows: rows,
    findOne: jest.fn((filter) => chain(() => {
      const row = rows.find((r) => matches(r, filter));
      return row ? { ...row } : null;
    })),
    find: jest.fn((filter) => chain(() => rows.filter((r) => matches(r, filter))
      .sort((a, b) => b.count - a.count).slice(0, 3).map((r) => ({ ...r })))),
    updateOne: jest.fn(async (filter, update) => {
      const row = rows.find((r) => matches(r, filter));
      if (!row) return { modifiedCount: 0 };
      if (update.$set) Object.assign(row, update.$set);
      if (update.$unset) for (const k of Object.keys(update.$unset)) delete row[k];
      return { modifiedCount: 1 };
    }),
  };
});
jest.mock('../models/ChatUsage', () => ({
  find: jest.fn(() => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => [{ userId: 'c1', count: 40 }] })),
}));
jest.mock('../models/SiteConfig', () => ({
  findOne: jest.fn(() => ({ lean: async () => ({ key: 'contactEmail', value: 'admin@example.com' }) })),
}));
jest.mock('./mailgun', () => ({
  sendAiCapAlertEmail: jest.fn(async () => {}),
  get EMAIL_VERIFICATION_ENABLED() { return mockState.emailEnabled; },
}));

const AiUsage = require('../models/AiUsage');
const SiteConfig = require('../models/SiteConfig');
const { sendAiCapAlertEmail } = require('./mailgun');
const rateLimitsConfig = require('../config/rateLimits');
const { runAiCapAlertCheck } = require('./aiCapAlertJob');

const NOW = new Date('2026-09-27T12:00:00Z');
const DATE = '2026-09-27';

function setCap(max) {
  rateLimitsConfig.set({ ...JSON.parse(JSON.stringify(rateLimitsConfig.defaults)), aiGlobalDailyCap: { max } });
}
function setToday(count) {
  let row = AiUsage.__rows.find((r) => r.userId === null && r.date === DATE);
  if (!row) { row = { userId: null, date: DATE, count: 0 }; AiUsage.__rows.push(row); }
  row.count = count;
}
const globalRow = () => AiUsage.__rows.find((r) => r.userId === null && r.date === DATE);

beforeEach(() => {
  AiUsage.__rows.length = 0;
  AiUsage.__rows.push({ userId: 'u1', date: DATE, count: 300 }, { userId: 'u2', date: DATE, count: 12 });
  sendAiCapAlertEmail.mockReset().mockResolvedValue(undefined);
  mockState.emailEnabled = true;
  setCap(1000);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

test('below 50% of the cap: no email', async () => {
  setToday(499);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 0 });
  expect(sendAiCapAlertEmail).not.toHaveBeenCalled();
});

test('50%: one email with the count, the cap, the reset time and the top accounts; not again at 60%', async () => {
  setToday(500);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 50 });
  expect(sendAiCapAlertEmail).toHaveBeenCalledTimes(1);
  const [to, alert] = sendAiCapAlertEmail.mock.calls[0];
  expect(to).toBe('admin@example.com');
  expect(alert).toMatchObject({ pct: 50, count: 500, cap: 1000, resetsInSeconds: 12 * 3600 });
  expect(alert.topAi).toEqual([{ userId: 'u1', count: 300 }, { userId: 'u2', count: 12 }]);
  expect(alert.topChat).toEqual([{ userId: 'c1', count: 40 }]);
  expect(globalRow()).toMatchObject({ alertedPct: 50, alertedCap: 1000 });

  setToday(600);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 0 });
  expect(sendAiCapAlertEmail).toHaveBeenCalledTimes(1);
});

test('80% and 100% each send once more', async () => {
  setToday(500);
  await runAiCapAlertCheck(NOW);
  setToday(800);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 80 });
  setToday(1000);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 100 });
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 0 });
  expect(sendAiCapAlertEmail.mock.calls.map((c) => c[1].pct)).toEqual([50, 80, 100]);
});

test('several thresholds crossed between two runs: one email, for the highest', async () => {
  setToday(850);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 80 });
  expect(sendAiCapAlertEmail).toHaveBeenCalledTimes(1);
  expect(globalRow().alertedPct).toBe(80);
});

test('two runs at once (a second process): only the one that wins the claim sends', async () => {
  setToday(500);
  const results = await Promise.all([runAiCapAlertCheck(NOW), runAiCapAlertCheck(NOW)]);
  expect(results.filter((r) => r.sent === 1)).toHaveLength(1);
  expect(sendAiCapAlertEmail).toHaveBeenCalledTimes(1);
});

test('a failed send gives the claim back, so the next run tries again', async () => {
  setToday(500);
  sendAiCapAlertEmail.mockRejectedValueOnce(new Error('mailgun down'));
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 0, reason: 'send_failed' });
  expect(globalRow().alertedPct).toBeUndefined();
  expect(globalRow().alertedCap).toBeUndefined();
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 50 });
});

test('a failed 80% send falls back to the 50% already sent, not to nothing', async () => {
  setToday(500);
  await runAiCapAlertCheck(NOW);
  setToday(800);
  sendAiCapAlertEmail.mockRejectedValueOnce(new Error('mailgun down'));
  await runAiCapAlertCheck(NOW);
  expect(globalRow()).toMatchObject({ alertedPct: 50, alertedCap: 1000 });
});

// Raising the cap is what the email suggests: the new cap's thresholds must
// warn again, not stay silenced by the warnings sent under the old one.
test('after the cap is changed, its thresholds warn again', async () => {
  setToday(1000);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 100 });
  setCap(2000);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 50 });
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 0 });
  setToday(1600);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 80 });
  setToday(2000);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 1, pct: 100 });
  expect(sendAiCapAlertEmail.mock.calls.map((c) => [c[1].pct, c[1].cap])).toEqual([[100, 1000], [50, 2000], [80, 2000], [100, 2000]]);
});

test('with the per-user budget unlimited, the top AI accounts are reported as not tracked', async () => {
  rateLimitsConfig.set({ ...JSON.parse(JSON.stringify(rateLimitsConfig.defaults)), aiGlobalDailyCap: { max: 1000 }, aiDailyBudget: { max: 0 } });
  setToday(500);
  await runAiCapAlertCheck(NOW);
  expect(sendAiCapAlertEmail.mock.calls[0][1].topAi).toBeNull();
  expect(sendAiCapAlertEmail.mock.calls[0][1].topChat).toEqual([{ userId: 'c1', count: 40 }]);
});

test('nothing is claimed or sent when the cap is off, email is not set up, or no contact address is set', async () => {
  setToday(900);
  setCap(0);
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 0, reason: 'cap_disabled' });

  setCap(1000);
  mockState.emailEnabled = false;
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 0, reason: 'email_disabled' });

  mockState.emailEnabled = true;
  SiteConfig.findOne.mockReturnValueOnce({ lean: async () => null });
  expect(await runAiCapAlertCheck(NOW)).toEqual({ sent: 0, reason: 'no_contact_email' });

  expect(globalRow().alertedPct).toBeUndefined();
  expect(sendAiCapAlertEmail).not.toHaveBeenCalled();
});

test('a new day starts again from nothing', async () => {
  setToday(500);
  await runAiCapAlertCheck(NOW);
  AiUsage.__rows.push({ userId: null, date: '2026-09-28', count: 500 });
  expect(await runAiCapAlertCheck(new Date('2026-09-28T09:00:00Z'))).toEqual({ sent: 1, pct: 50 });
});
