/**
 * Activation, once self-hosted installs exist.
 *
 * A self-hoster who connects their own Cellarion to the shared registry needs
 * an account here, but their cellar lives on their server. They will never add
 * a bottle to this instance — that is the design, not a failure. Counted in
 * the activation denominator they read as signups that never activated, and
 * every install the beta adds pushes the figure further down: the number gets
 * worse precisely as the feature succeeds.
 *
 * These pin the two derivations that keep that from happening.
 */
const { __testing } = require('./globalStatsService');

const { buildBridgeSummary, buildActivation } = __testing;

describe('buildBridgeSummary', () => {
  it('counts a bridge account with no bottles here as bridge-only', () => {
    const s = buildBridgeSummary({ accounts: 3, ownersWithBottles: 0, liveKeyOwners: 3, everKeyOwners: 4 });
    expect(s.bridgeOnly).toBe(3);
    expect(s.accounts).toBe(3);
  });

  it('stops counting someone as bridge-only once they add a bottle here', () => {
    // Nothing is migrated for this to happen: the flag is derived per read, so
    // a self-hoster who also keeps a cellar here simply drops out of the count.
    const s = buildBridgeSummary({ accounts: 3, ownersWithBottles: 1 });
    expect(s.bridgeOnly).toBe(2);
  });

  it('never reports a negative count when the two queries disagree', () => {
    // accounts and ownersWithBottles come from separate queries; a bottle added
    // between them can make the subtraction go negative.
    const s = buildBridgeSummary({ accounts: 2, ownersWithBottles: 5 });
    expect(s.bridgeOnly).toBe(0);
  });

  it('reports live and ever-connected keys separately', () => {
    // Revoking a key must not erase the fact that an install once connected —
    // that history is the whole point of the ever-connected figure.
    const s = buildBridgeSummary({ accounts: 4, ownersWithBottles: 0, liveKeyOwners: 1, everKeyOwners: 4 });
    expect(s.liveKeys).toBe(1);
    expect(s.everConnected).toBe(4);
  });

  it('is all zeros before anyone connects, rather than undefined', () => {
    expect(buildBridgeSummary({})).toEqual({
      accounts: 0, bridgeOnly: 0, liveKeys: 0, everConnected: 0,
    });
  });
});

describe('buildActivation', () => {
  it('divides by the people who could actually add a bottle here', () => {
    // 100 accounts, 20 of them bridge-only, 40 with bottles: 40/80, not 40/100.
    const a = buildActivation({ totalUsers: 100, usersWithBottles: 40, bridgeOnlyUsers: 20 });
    expect(a.cellarUsers).toBe(80);
    expect(a.activationPct).toBe(50);
  });

  it('does not move when a new self-hosted install signs up', () => {
    // The regression this file exists for: adding installs must not make
    // activation look worse.
    const before = buildActivation({ totalUsers: 100, usersWithBottles: 40, bridgeOnlyUsers: 20 });
    const after = buildActivation({ totalUsers: 110, usersWithBottles: 40, bridgeOnlyUsers: 30 });
    expect(after.activationPct).toBe(before.activationPct);
  });

  it('matches plain activation when there are no bridge accounts', () => {
    const a = buildActivation({ totalUsers: 50, usersWithBottles: 20, bridgeOnlyUsers: 0 });
    expect(a.cellarUsers).toBe(50);
    expect(a.activationPct).toBe(40);
  });

  it('returns 0% rather than dividing by zero on an empty instance', () => {
    expect(buildActivation({ totalUsers: 0, usersWithBottles: 0, bridgeOnlyUsers: 0 }).activationPct).toBe(0);
  });

  it('returns 0% when every account is bridge-only', () => {
    // A registry-only deployment: nobody keeps a cellar here, so there is no
    // activation question to answer — and certainly no division to attempt.
    const a = buildActivation({ totalUsers: 5, usersWithBottles: 0, bridgeOnlyUsers: 5 });
    expect(a.cellarUsers).toBe(0);
    expect(a.activationPct).toBe(0);
  });
});
