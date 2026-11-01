/**
 * services/lastActive — the day an account was last used (User.lastActiveAt).
 * Pinned: a day and nothing finer (UTC midnight), it only moves forward, and
 * the standalone write can never fail the request that triggered it.
 */
jest.mock('../models/User', () => ({ updateOne: jest.fn() }));

const User = require('../models/User');
const { activeDay, markActive, touchLastActive } = require('./lastActive');

beforeEach(() => jest.clearAllMocks());

test('the stored value is UTC midnight of the day, whatever the time of day', () => {
  expect(activeDay(new Date('2026-10-31T23:59:59.999Z'))).toEqual(new Date('2026-10-31T00:00:00.000Z'));
  expect(activeDay(Date.UTC(2026, 9, 31, 0, 0, 1))).toEqual(new Date('2026-10-31T00:00:00.000Z'));
});

describe('markActive (on a document the caller saves)', () => {
  test('sets the day on an account that has none', () => {
    const user = { lastActiveAt: null };
    markActive(user, new Date('2026-10-31T15:20:00Z'));
    expect(user.lastActiveAt).toEqual(new Date('2026-10-31T00:00:00Z'));
  });

  test('moves it forward to a later day', () => {
    const user = { lastActiveAt: new Date('2026-10-01T00:00:00Z') };
    markActive(user, new Date('2026-10-31T08:00:00Z'));
    expect(user.lastActiveAt).toEqual(new Date('2026-10-31T00:00:00Z'));
  });

  test('never moves it back, and leaves the same day as it is', () => {
    const later = new Date('2026-11-02T00:00:00Z');
    const user = { lastActiveAt: later };
    markActive(user, new Date('2026-10-31T08:00:00Z'));
    expect(user.lastActiveAt).toBe(later);

    const today = new Date('2026-10-31T00:00:00Z');
    const same = { lastActiveAt: today };
    markActive(same, new Date('2026-10-31T22:00:00Z'));
    expect(same.lastActiveAt).toBe(today);
  });
});

describe('touchLastActive (a standalone write)', () => {
  test('writes the day with $max, so it can only move forward', async () => {
    User.updateOne.mockResolvedValue({});
    await touchLastActive('u1', new Date('2026-10-31T10:00:00Z'));
    expect(User.updateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $max: { lastActiveAt: new Date('2026-10-31T00:00:00Z') } });
  });

  test('a failed write resolves anyway (it must never fail the request)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    User.updateOne.mockRejectedValue(new Error('connection closed'));
    await expect(touchLastActive('u1')).resolves.toBeUndefined();

    User.updateOne.mockImplementation(() => { throw new Error('not connected'); });
    await expect(touchLastActive('u1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
