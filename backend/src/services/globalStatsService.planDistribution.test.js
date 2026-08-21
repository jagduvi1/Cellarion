/**
 * Every configured plan tier appears in the distribution, including the ones
 * nobody is on.
 *
 * The bug (found 2026-08-21, present since the tiers shipped in v1.140):
 * $group only emits a row per DISTINCT VALUE PRESENT, so `benefactor` — with
 * zero users — was absent from the table entirely. "Nobody has chosen
 * benefactor" then read identically to "benefactor doesn't exist", which is
 * exactly the question worth asking after a repricing.
 */
const { PLAN_NAMES } = require('../config/plans');
const { __testing } = require('./globalStatsService');

// The REAL builder, not a copy of it. A test that re-implements the rule next
// to the rule passes even when the two drift apart, which is the one thing a
// regression test must not do.
const buildDistribution = __testing.buildPlanDistribution;

describe('plan distribution', () => {
  it('includes a configured tier nobody is on', () => {
    // Real prod shape on the day this was found.
    const out = buildDistribution([
      { _id: 'free', count: 301 }, { _id: 'supporter', count: 3 }, { _id: 'patron', count: 1 },
    ]);
    const benefactor = out.find((r) => r.plan === 'benefactor');
    expect(benefactor).toEqual({ plan: 'benefactor', count: 0 });
  });

  it('lists every configured tier, in the config ladder order', () => {
    // Ladder order, not count order: the ladder IS the price order, and
    // reading it that way is the point of the table.
    const out = buildDistribution([{ _id: 'patron', count: 9 }, { _id: 'free', count: 2 }]);
    expect(out.slice(0, PLAN_NAMES.length).map((r) => r.plan)).toEqual(PLAN_NAMES);
  });

  it('keeps a plan value the config does NOT define, flagged', () => {
    // A retired or hand-set tier is still real users. Dropping it would be the
    // same bug in the other direction — a number the page cannot show.
    const out = buildDistribution([{ _id: 'free', count: 5 }, { _id: 'legacy_pro', count: 2 }]);
    expect(out.at(-1)).toEqual({ plan: 'legacy_pro', count: 2, unconfigured: true });
  });

  it('survives a null plan value without inventing a tier for it', () => {
    const out = buildDistribution([{ _id: null, count: 4 }]);
    expect(out.find((r) => r.plan === 'free')).toEqual({ plan: 'free', count: 0 });
    expect(out.at(-1)).toMatchObject({ plan: null, count: 4, unconfigured: true });
  });

  it('returns the full ladder even when there are no users at all', () => {
    expect(buildDistribution([])).toEqual(PLAN_NAMES.map((plan) => ({ plan, count: 0 })));
  });
});

// Audit 2026-08-21 H-1. The shape of the CHURN query, pinned as data because
// the wrong shape shipped and measured 7 where the truth was 3: Stripe
// customers are created at checkout-session time, BEFORE payment, so keying
// churn on stripeCustomerId counts abandoned checkouts as former supporters.
describe('formerSupporters query shape (H-1)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./globalStatsService'), 'utf8');

  it('keys on planStartedAt, which is stamped only when a tier is granted', () => {
    expect(src).toMatch(/plan:\s*'free',\s*planStartedAt:\s*\{\s*\$ne:\s*null\s*\}/);
  });

  it('never again keys churn on stripeCustomerId', () => {
    expect(src).not.toMatch(/plan:\s*'free',\s*stripeCustomerId/);
  });
});
