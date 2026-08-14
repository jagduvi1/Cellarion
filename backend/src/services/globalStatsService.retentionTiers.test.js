const { __testing } = require('./globalStatsService');

const { DAY_TIERS, tierAccumulators, tierRows } = __testing;

describe('retention day-ladder (DAY_TIERS)', () => {
  it('is ascending and starts at 2 — a single day is never "returning"', () => {
    expect(DAY_TIERS[0]).toBe(2);
    const sorted = [...DAY_TIERS].sort((a, b) => a - b);
    expect(DAY_TIERS).toEqual(sorted);
    expect(new Set(DAY_TIERS).size).toBe(DAY_TIERS.length);
  });

  it('tops out well inside the audit TTL, so the login ladder can be reached', () => {
    // The login side only sees AUDIT_TTL_DAYS (90d default) of history. A tier
    // near that bound would mean "N of the last 90 days" and sit at 0 forever.
    // Raising this is a product call, not an oversight — update the cap here
    // and the tooltip copy together.
    expect(Math.max(...DAY_TIERS)).toBeLessThanOrEqual(7);
  });

  describe('tierAccumulators', () => {
    it('emits one >= accumulator per tier, keyed t<days>', () => {
      const acc = tierAccumulators('$activeDays');
      expect(Object.keys(acc)).toEqual(DAY_TIERS.map(n => `t${n}`));
      expect(acc.t2).toEqual({ $sum: { $cond: [{ $gte: ['$activeDays', 2] }, 1, 0] } });
    });

    it('binds to whichever day field it is given', () => {
      const acc = tierAccumulators('$loginDays');
      expect(acc.t4).toEqual({ $sum: { $cond: [{ $gte: ['$loginDays', 4] }, 1, 0] } });
    });
  });

  describe('tierRows', () => {
    it('maps aggregate output to {days, users, pct} over the given denominator', () => {
      const rows = tierRows({ t2: 50, t4: 25, t7: 10 }, 100);
      expect(rows).toEqual([
        { days: 2, users: 50, pct: 50 },
        { days: 4, users: 25, pct: 25 },
        { days: 7, users: 10, pct: 10 },
      ]);
    });

    it('treats tiers as nested subsets, not disjoint buckets', () => {
      const rows = tierRows({ t2: 50, t4: 25, t7: 10 }, 100);
      const users = rows.map(r => r.users);
      // Every tier is contained in the one before it, so counts never rise.
      expect(users).toEqual([...users].sort((a, b) => b - a));
    });

    it('defaults missing tier counts to 0 rather than NaN', () => {
      // Mongo omits the row entirely when nothing matched.
      const rows = tierRows({}, 0);
      expect(rows.every(r => r.users === 0 && r.pct === 0)).toBe(true);
      expect(rows).toHaveLength(DAY_TIERS.length);
    });

    it('does not divide by zero when there are no users', () => {
      expect(tierRows({ t2: 0 }, 0)[0].pct).toBe(0);
    });
  });
});
