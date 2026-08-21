/**
 * "Of the people who signed up N weeks ago, how many came back?"
 *
 * The trap this exists to hold shut: the NEWEST cohort cannot be asked. Its
 * members are active in the last 7 days because they SIGNED UP in the last 7
 * days. Measured live on 2026-08-21 that read 97% next to 39% and 35% for the
 * two cohorts behind it — a tautology sitting where a headline number goes.
 */
const { __testing } = require('./globalStatsService');

const { buildSignupCohorts, COHORT_WINDOW_DAYS, COHORT_SPAN_DAYS } = __testing;

// Time is injected rather than mocked so these never race midnight.
const NOW = Date.parse('2026-08-21T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000);
const user = (id, n) => ({ _id: id, createdAt: daysAgo(n) });

describe('buildSignupCohorts', () => {
  it('never reports a rate for the newest cohort', () => {
    // Three users who joined this week and are all "active" — because joining
    // IS activity. A percentage here would say 100% and mean nothing.
    const users = [user('a', 1), user('b', 3), user('c', 6)];
    const [newest] = buildSignupCohorts(users, new Set(['a', 'b', 'c']), NOW);
    expect(newest).toMatchObject({ daysAgoFrom: 0, signedUp: 3, tooNew: true });
    expect(newest.returned).toBeNull();
    expect(newest.pct).toBeNull();
  });

  it('reports a real rate for cohorts old enough to have left and come back', () => {
    const users = [user('a', 8), user('b', 9), user('c', 10), user('d', 11)];
    const cohorts = buildSignupCohorts(users, new Set(['a', 'c']), NOW);
    const wk2 = cohorts.find((c) => c.daysAgoFrom === 7);
    expect(wk2).toMatchObject({ signedUp: 4, returned: 2, pct: 50, tooNew: false });
  });

  it('puts an exact-boundary signup in the NEWER cohort, once', () => {
    // Buckets are [now-end, now-start): the older edge is inclusive, so a user
    // aged exactly 7 days is the lower bound of 0-7 and lands there, not in
    // 7-14. Which side it falls is arbitrary; that it falls on exactly ONE
    // side is not — the alternative is a user double-counted or dropped.
    const cohorts = buildSignupCohorts([user('edge', 7)], new Set(), NOW);
    expect(cohorts.find((c) => c.daysAgoFrom === 0).signedUp).toBe(1);
    expect(cohorts.find((c) => c.daysAgoFrom === 7).signedUp).toBe(0);
    expect(cohorts.reduce((s, c) => s + c.signedUp, 0)).toBe(1);
  });

  it('places every user in exactly one bucket across the whole span', () => {
    // The property that actually matters, checked at every boundary rather
    // than at one hand-picked case.
    const users = Array.from({ length: COHORT_SPAN_DAYS }, (_, i) => user(`u${i}`, i));
    const cohorts = buildSignupCohorts(users, new Set(), NOW);
    expect(cohorts.reduce((s, c) => s + c.signedUp, 0)).toBe(users.length);
  });

  it('covers the full span with contiguous, non-overlapping windows', () => {
    const cohorts = buildSignupCohorts([], new Set(), NOW);
    expect(cohorts).toHaveLength(COHORT_SPAN_DAYS / COHORT_WINDOW_DAYS);
    for (let i = 0; i < cohorts.length; i++) {
      expect(cohorts[i].daysAgoFrom).toBe(i * COHORT_WINDOW_DAYS);
      expect(cohorts[i].daysAgoTo).toBe((i + 1) * COHORT_WINDOW_DAYS);
    }
  });

  it('ignores users older than the span', () => {
    const cohorts = buildSignupCohorts([user('ancient', 400)], new Set(['ancient']), NOW);
    expect(cohorts.reduce((s, c) => s + c.signedUp, 0)).toBe(0);
  });

  it('reports 0%, not a crash, for a cohort nobody joined', () => {
    const cohorts = buildSignupCohorts([], new Set(), NOW);
    const wk2 = cohorts.find((c) => c.daysAgoFrom === 7);
    expect(wk2).toMatchObject({ signedUp: 0, returned: 0, pct: 0 });
  });

  it('compares ids as strings — a real ObjectId is not === its string form', () => {
    // activeIds comes from AuditLog.distinct() and the users from a lean()
    // find; both sides are ObjectId-ish, and a raw === would silently match
    // nothing and report 0% retention forever.
    const oid = { toString: () => 'objid-1' };
    const cohorts = buildSignupCohorts([{ _id: oid, createdAt: daysAgo(9) }], new Set(['objid-1']), NOW);
    expect(cohorts.find((c) => c.daysAgoFrom === 7)).toMatchObject({ returned: 1, pct: 100 });
  });
});

describe('the newest bucket has no upper bound', () => {
  it('counts a user created at the exact query instant', () => {
    // With `< now` as the upper edge this user fell out of every bucket and
    // vanished from the intake count. Found by the every-user-lands-somewhere
    // property test, not by a hand-picked case.
    const cohorts = buildSignupCohorts([{ _id: 'x', createdAt: new Date(NOW) }], new Set(), NOW);
    expect(cohorts[0].signedUp).toBe(1);
  });

  it('counts a user whose createdAt is slightly in the FUTURE (clock skew)', () => {
    const ahead = new Date(NOW + 2000);
    const cohorts = buildSignupCohorts([{ _id: 'skewed', createdAt: ahead }], new Set(), NOW);
    expect(cohorts[0].signedUp).toBe(1);
    expect(cohorts.reduce((s, c) => s + c.signedUp, 0)).toBe(1);
  });
});
