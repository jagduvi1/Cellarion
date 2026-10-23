/**
 * scripts/new-member-emails-backtest — runs the job's own selection over past
 * days, read-only.
 *
 * WHY THIS TEST EXISTS:
 * The emails are switched on only after this backtest has been read, so it
 * must call the real selection in backtest mode at 17:00 UTC of each day,
 * count every account once (an account sits in the window on two runs), and
 * only claim a "came back anyway" outcome once seven days have passed.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/newMemberEmails', () => ({ findCandidates: jest.fn() }));

const AuditLog = require('../models/AuditLog');
const { findCandidates } = require('../services/newMemberEmails');
const { backtest } = require('./new-member-emails-backtest');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-23T18:30:00Z');

afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

test('one run per day at 17:00 UTC, in backtest mode, each account counted once', async () => {
  const u = (id) => ({ _id: id });
  // u1 and u3 show up on two consecutive runs, as the window allows
  findCandidates
    .mockResolvedValueOnce([{ user: u('u1'), choice: 'cellar' }, { user: u('u2'), choice: 'skip:cameBack' }])
    .mockResolvedValueOnce([{ user: u('u1'), choice: 'cellar' }, { user: u('u3'), choice: 'empty' }])
    .mockResolvedValueOnce([{ user: u('u3'), choice: 'empty' }, { user: u('u4'), choice: 'skip:member' }]);
  jest.spyOn(AuditLog, 'exists').mockResolvedValue(null);

  const rows = await backtest({ days: 3, now: NOW });

  expect(findCandidates.mock.calls.map(([a]) => [a.runAt.toISOString(), a.live])).toEqual([
    ['2026-10-21T17:00:00.000Z', false],
    ['2026-10-22T17:00:00.000Z', false],
    ['2026-10-23T17:00:00.000Z', false],
  ]);
  expect(rows.map((r) => [r.day, r.considered, r.cellar, r.empty, r.skipped])).toEqual([
    ['2026-10-21', 2, 1, 0, { cameBack: 1 }],
    ['2026-10-22', 1, 0, 1, {}],
    ['2026-10-23', 1, 0, 0, { member: 1 }],
  ]);
});

test('before 17:00 UTC the last run is yesterday\'s', async () => {
  findCandidates.mockResolvedValue([]);
  await backtest({ days: 1, now: new Date('2026-10-23T09:00:00Z') });
  expect(findCandidates.mock.calls[0][0].runAt.toISOString()).toBe('2026-10-22T17:00:00.000Z');
});

test('"came back anyway" looks at the 7 days after the run, and only counts once they have passed', async () => {
  findCandidates
    .mockResolvedValueOnce([{ user: { _id: 'old' }, choice: 'empty' }])
    .mockResolvedValue([]);
  const exists = jest.spyOn(AuditLog, 'exists').mockResolvedValue({ _id: 'row' });

  const rows = await backtest({ days: 10, now: NOW });

  const run = new Date('2026-10-14T17:00:00Z');
  expect(exists.mock.calls[0][0].timestamp).toEqual({ $gte: run, $lt: new Date(run.getTime() + 7 * DAY) });
  expect(rows[0]).toMatchObject({ day: '2026-10-14', empty: 1, backWithin7: { cellar: 0, empty: 1 }, outcomeKnown: true });
  expect(rows[rows.length - 1].outcomeKnown).toBe(false);
});
