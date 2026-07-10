const {
  PRESERVATION_FRESHNESS_DAYS,
  openBottleDeadline,
  openBottleDaysLeft,
  shouldNotifyOpenBottle,
} = require('./openBottleUtils');

const DAY = 86400000;
const openedAt = new Date('2026-07-01T12:00:00Z');

describe('openBottleDeadline', () => {
  test('adds the method freshness window to openedAt', () => {
    expect(openBottleDeadline({ openedAt, preservationMethod: 'coravin' }).getTime() - openedAt.getTime())
      .toBe(90 * DAY);
    expect(openBottleDeadline({ openedAt, preservationMethod: 'vacuum' }).getTime() - openedAt.getTime())
      .toBe(4 * DAY);
  });

  test('unknown or missing method falls back to the shortest window', () => {
    expect(openBottleDeadline({ openedAt }).getTime() - openedAt.getTime()).toBe(2 * DAY);
    expect(openBottleDeadline({ openedAt, preservationMethod: 'bogus' }).getTime() - openedAt.getTime()).toBe(2 * DAY);
  });

  test('unopened bottles have no deadline', () => {
    expect(openBottleDeadline({})).toBeNull();
    expect(openBottleDeadline(null)).toBeNull();
  });

  test('every method has a positive window', () => {
    for (const days of Object.values(PRESERVATION_FRESHNESS_DAYS)) {
      expect(days).toBeGreaterThan(0);
    }
  });
});

describe('openBottleDaysLeft / shouldNotifyOpenBottle', () => {
  const vacuumBottle = { openedAt, preservationMethod: 'vacuum' }; // deadline 2026-07-05T12:00Z

  test('counts down toward the deadline', () => {
    expect(openBottleDaysLeft(vacuumBottle, new Date('2026-07-02T12:00:00Z'))).toBe(3);
    expect(openBottleDaysLeft(vacuumBottle, new Date('2026-07-05T00:00:00Z'))).toBe(1);
    expect(openBottleDaysLeft(vacuumBottle, new Date('2026-07-06T12:00:00Z'))).toBe(-1);
  });

  test('quiet while more than a day remains', () => {
    expect(shouldNotifyOpenBottle(vacuumBottle, new Date('2026-07-02T12:00:00Z'))).toBe(false);
    expect(shouldNotifyOpenBottle(vacuumBottle, new Date('2026-07-03T11:00:00Z'))).toBe(false);
  });

  test('fires on the last day and once past the window', () => {
    expect(shouldNotifyOpenBottle(vacuumBottle, new Date('2026-07-05T00:00:00Z'))).toBe(true); // last day
    expect(shouldNotifyOpenBottle(vacuumBottle, new Date('2026-07-08T00:00:00Z'))).toBe(true); // past
  });

  test('never fires for unopened bottles', () => {
    expect(shouldNotifyOpenBottle({}, new Date())).toBe(false);
  });

  test('coravin stays quiet for months', () => {
    const coravin = { openedAt, preservationMethod: 'coravin' };
    expect(shouldNotifyOpenBottle(coravin, new Date('2026-08-15T12:00:00Z'))).toBe(false);
    expect(shouldNotifyOpenBottle(coravin, new Date('2026-09-29T00:00:00Z'))).toBe(true); // day 90
  });
});
