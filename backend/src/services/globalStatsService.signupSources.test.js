/**
 * "Signups by source" on the admin stats page: which channels bring people who
 * add a bottle and come back.
 *
 * WHY THIS TEST EXISTS:
 * It shares the signup-cohort trap — someone who joined this week is "present"
 * because joining is presence — so "came back" must only be asked of accounts
 * old enough to have left.
 */
const { __testing } = require('./globalStatsService');

const { buildSignupSources, SOURCE_SPAN_DAYS } = __testing;

const NOW = Date.parse('2026-10-03T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000);
const user = (id, n, signupSource) => ({ _id: id, createdAt: daysAgo(n), signupSource });

describe('buildSignupSources', () => {
  it('groups by channel and counts bottles and returns per channel', () => {
    const users = [
      user('a', 20, { referrerDomain: 'reddit.com' }),
      user('b', 30, { referrerDomain: 'old.reddit.com' }),
      user('c', 10, { referrerDomain: 'google.se' }),
      user('d', 40, undefined),
    ];
    const out = buildSignupSources(users, new Set(['a', 'c']), new Set(['a', 'b']), NOW);
    expect(out.spanDays).toBe(SOURCE_SPAN_DAYS);
    expect(out.rows[0]).toEqual({
      channel: 'reddit', signedUp: 2, addedBottle: 1, mature: 2, returned: 2,
      addedBottlePct: 50, returnedPct: 100,
    });
    expect(out.rows.find((r) => r.channel === 'search')).toMatchObject({ signedUp: 1, addedBottle: 1, returned: 0 });
    expect(out.rows.find((r) => r.channel === 'unknown')).toMatchObject({ signedUp: 1 });
  });

  it('never asks "came back" of accounts from this week', () => {
    const users = [user('a', 1, {}), user('b', 3, {})];
    const [direct] = buildSignupSources(users, new Set(), new Set(['a', 'b']), NOW).rows;
    expect(direct).toMatchObject({ channel: 'direct', signedUp: 2, mature: 0, returned: 0, returnedPct: null });
  });

  it('lists the most common other sites, so a new channel is visible', () => {
    const users = [
      user('a', 9, { referrerDomain: 'winesforum.example' }),
      user('b', 9, { referrerDomain: 'winesforum.example' }),
      user('c', 9, { referrerDomain: 'blog.example' }),
      user('d', 9, { referrerDomain: 'reddit.com' }),
    ];
    const out = buildSignupSources(users, new Set(), new Set(), NOW);
    expect(out.otherSites).toEqual([
      { domain: 'winesforum.example', count: 2 },
      { domain: 'blog.example', count: 1 },
    ]);
  });
});
