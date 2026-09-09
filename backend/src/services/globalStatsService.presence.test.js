/**
 * The presence ladder: returning users measured by showing up, not by
 * changing a cellar.
 *
 * Two facts about the audit collection make this easy to get silently wrong,
 * and neither is visible in the schema. Both cost real debugging time on
 * 2026-09-09 and are pinned here so the next change cannot quietly undo them.
 *
 *   1. A sign-in row is written BEFORE the request is authenticated, so its
 *      actor is anonymous. Every one of the 2,081 login rows in production had
 *      `actor.userId: null`, with the account in `resource.id` instead.
 *      Grouping on actor.userId alone counts every sign-in as nobody.
 *
 *   2. Password sign-in and single sign-on write DIFFERENT action names.
 *      Matching only 'auth.login.success' silently drops every SSO-only
 *      account — 266 of those rows in the same window.
 *
 * A login-only version of this metric was removed in August for undercounting.
 * Measured against production, sign-in events alone found 105 returning users
 * where presence found 130, so the undercount was real and large. These tests
 * exist to keep the fix, not the old metric.
 */
const { __testing } = require('./globalStatsService');

const {
  buildPresencePipeline, buildPresenceWindowPipeline,
  SIGNIN_ACTIONS, MACHINE_ACTIONS, AUDIT_TTL_DAYS, DAY_TIERS,
} = __testing;

const build = (over = {}) =>
  buildPresencePipeline({ since: new Date('2026-06-11T00:00:00Z'), excludedIds: [], ...over });

// Find a stage by its operator, so an added stage does not break every test.
const stagesOf = (pipeline, op) => pipeline.filter((s) => Object.keys(s)[0] === op);

describe('SIGNIN_ACTIONS', () => {
  it('covers single sign-on as well as password login', () => {
    // The whole trap: an SSO-only user never writes auth.login.success, so
    // matching that alone would report them as never having signed in.
    expect(SIGNIN_ACTIONS).toContain('auth.login.success');
    expect(SIGNIN_ACTIONS).toContain('auth.oauth.success');
  });

  it('does not count demo sign-ins', () => {
    // Demo accounts are two-hour clones, excluded from every other figure on
    // the page. Counting their logins here would contradict the rest of it.
    expect(SIGNIN_ACTIONS).not.toContain('auth.demo_login');
  });
});

describe('MACHINE_ACTIONS', () => {
  it('treats API-token traffic as a machine, not a person', () => {
    // token.used is written hourly by whatever holds the token, and several
    // production tokens are called "Home Assistant" or "Climate device".
    // Counting them marks their owner present every day for ever: measured
    // 2026-09-09 they inflated the 7-or-more-days tier from 44 users to 63.
    expect(MACHINE_ACTIONS).toContain('token.used');
    expect(MACHINE_ACTIONS).toContain('oauth.token_refreshed');
  });

  it('does not swallow a sign-in', () => {
    // Signing in IS a person arriving. If the two lists ever overlapped, the
    // pipeline would exclude the very rows it then tries to resolve.
    for (const action of SIGNIN_ACTIONS) expect(MACHINE_ACTIONS).not.toContain(action);
  });
});

describe('buildPresencePipeline', () => {
  it('drops machine traffic before counting anybody', () => {
    // The exclusion has to be in the first stage, so a polling integration
    // never reaches the day-grouping and cannot manufacture a daily user.
    expect(build()[0].$match.action).toEqual({ $nin: MACHINE_ACTIONS });
  });


  it('resolves a sign-in row to the account in resource.id, not the null actor', () => {
    const project = stagesOf(build(), '$project')[0].$project;
    expect(project.who.$cond[0]).toEqual({ $in: ['$action', SIGNIN_ACTIONS] });
    expect(project.who.$cond[1]).toBe('$resource.id');  // sign-in: the anonymous case
    expect(project.who.$cond[2]).toBe('$actor.userId'); // everything else
  });

  it('admits rows that have no actor, provided they are sign-ins', () => {
    // Without the $or, the first stage would drop every login row before the
    // projection ever got the chance to recover its account id.
    const first = build()[0].$match;
    expect(first.$or).toEqual([
      { 'actor.userId': { $ne: null } },
      { action: { $in: SIGNIN_ACTIONS } },
    ]);
  });

  it('applies the exclusion AFTER resolving who, so an excluded sign-in is dropped', () => {
    // Order is the whole point. Excluding by actor.userId before the
    // projection would let an admin's or a demo account's sign-in through,
    // because on those rows actor.userId is null rather than their id.
    const p = build({ excludedIds: ['admin-1'] });
    const projectAt = p.findIndex((s) => s.$project);
    const excludeAt = p.findIndex((s) => s.$match && s.$match.who);
    expect(projectAt).toBeGreaterThanOrEqual(0);
    expect(excludeAt).toBeGreaterThan(projectAt);
    expect(p[excludeAt].$match.who.$nin).toContain('admin-1');
  });

  it('excludes null so anonymous rows never become a user', () => {
    // A failed login from an unknown address has no account at all. It must
    // not group into a phantom "null user" that then counts as returning.
    const exclusion = build().find((s) => s.$match && s.$match.who).$match.who.$nin;
    expect(exclusion).toContain(null);
  });

  it('counts each user once per calendar day, not once per action', () => {
    // Someone who adds forty bottles in one sitting was present on one day.
    const groups = stagesOf(build(), '$group');
    expect(groups[0].$group._id).toEqual({ user: '$who', day: '$day' });
    expect(groups[1].$group.activeDays).toEqual({ $sum: 1 });
  });

  it('shares its rungs with the bottle ladder', () => {
    // Two ladders with different tiers would be unreadable side by side.
    const final = stagesOf(build(), '$group').pop().$group;
    for (const tier of DAY_TIERS) expect(final).toHaveProperty(`t${tier}`);
    expect(final.usersSeen).toEqual({ $sum: 1 });
  });

  it('honours the window it is given', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    expect(build({ since })[0].$match.timestamp).toEqual({ $gte: since });
  });
});

describe('buildPresenceWindowPipeline', () => {
  const WINDOWS = {
    w24h: new Date('2026-09-08T12:00:00Z'),
    w7d:  new Date('2026-09-02T12:00:00Z'),
  };
  const buildWindows = (over = {}) => buildPresenceWindowPipeline({
    since: new Date('2026-06-11T00:00:00Z'), excludedIds: [], windows: WINDOWS, ...over,
  });

  it('selects rows by the same rule as the ladder', () => {
    // Two different ideas of "was here" on one page would be indefensible.
    const ladder = build();
    const windows = buildWindows();
    expect(windows.slice(0, 3)).toEqual(ladder.slice(0, 3));
  });

  it('answers every window from one pass over the data', () => {
    // Reduce to each user's most recent moment, then test that moment against
    // each window — rather than re-scanning the collection once per window.
    const p = buildWindows();
    expect(p.find((s) => s.$group && s.$group.lastSeen).$group).toEqual({
      _id: '$who', lastSeen: { $max: '$at' },
    });
    const counts = p[p.length - 1].$group;
    expect(Object.keys(counts).filter((k) => k !== '_id')).toEqual(['w24h', 'w7d']);
  });

  it('compares against Date objects, never date strings', () => {
    // The trap, hit for real on 2026-09-09: BSON sorts every Date ABOVE every
    // String, so a threshold that arrives as an ISO string makes the window
    // match every user. It reads as a plausible number, not as an error —
    // 24h and 90d both came back as the full user base.
    const p = buildWindows();
    const counts = p[p.length - 1].$group;
    for (const key of Object.keys(WINDOWS)) {
      const threshold = counts[key].$sum.$cond[0].$gte[1];
      expect(threshold).toBeInstanceOf(Date);
    }
  });

  it('takes whatever windows it is handed, so adding one costs nothing', () => {
    const p = buildPresenceWindowPipeline({
      since: new Date('2026-06-11T00:00:00Z'),
      excludedIds: [],
      windows: { ...WINDOWS, w365d: new Date('2025-09-09T12:00:00Z') },
    });
    expect(Object.keys(p[p.length - 1].$group)).toContain('w365d');
  });

  it('still drops the excluded cohorts', () => {
    const p = buildWindows({ excludedIds: ['demo-1'] });
    expect(p[2].$match.who.$nin).toEqual(['demo-1', null]);
  });
});

describe('AUDIT_TTL_DAYS', () => {
  it('is a real window, so the page can disclose how far back presence sees', () => {
    // Read from the AuditLog model rather than restated here, so it cannot
    // disagree with the TTL index that actually deletes the rows.
    expect(typeof AUDIT_TTL_DAYS).toBe('number');
    expect(AUDIT_TTL_DAYS).toBeGreaterThan(0);
  });

  it('is long enough to reach the top rung of the ladder', () => {
    // A tier nobody can reach within the window would always read zero and
    // look like a dead product rather than an unmeasurable one.
    expect(AUDIT_TTL_DAYS).toBeGreaterThan(Math.max(...DAY_TIERS));
  });
});
