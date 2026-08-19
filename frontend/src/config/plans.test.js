import {
  PLANS,
  PLAN_NAMES,
  PAID_PLAN_NAMES,
  getPlanConfig,
} from './plans';
import backendPlans from '../../../backend/src/config/plans.js';

// ---------------------------------------------------------------------------
// PLAN_NAMES
// ---------------------------------------------------------------------------
describe('PLAN_NAMES', () => {
  it('contains all supporter tier keys', () => {
    expect(PLAN_NAMES).toEqual(['free', 'supporter', 'patron', 'benefactor']);
  });

  it('lists the paid tiers in ascending price order', () => {
    // The /supporter page renders them in this order and relies on the middle
    // one being the suggested tier — a reorder here silently moves the anchor.
    expect(PAID_PLAN_NAMES).toEqual(['supporter', 'patron', 'benefactor']);
    const prices = PAID_PLAN_NAMES.map((p) => PLANS[p].price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('marks no tier as recommended', () => {
    // Deliberate: a "Suggested" badge reads as an expectation to pay, and
    // supporting is entirely voluntary. Ordering alone puts the middle amount
    // in the middle.
    expect(PAID_PLAN_NAMES.filter((p) => PLANS[p].suggested)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pricing invariants
// ---------------------------------------------------------------------------
describe('pricing', () => {
  it('prices every paid tier annually at exactly 12x the monthly price', () => {
    // There is deliberately NO yearly discount — yearly is steered by being the
    // default cadence and by the card-fee framing, not by charging less. A drift
    // here would make the page's "same gift, fewer fees" copy a lie.
    for (const name of PAID_PLAN_NAMES) {
      expect(PLANS[name].annualPrice).toBe(PLANS[name].price * 12);
    }
  });

  it('gives the free tier no price of either cadence', () => {
    expect(PLANS.free.price).toBe(0);
    expect(PLANS.free.annualPrice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backend sync — the frontend config is a mirror of backend/src/config/plans.js
// and the two must never drift apart (labels/prices are shown in the UI and
// billed by the backend).
// ---------------------------------------------------------------------------
describe('backend config sync', () => {
  it('has the same plan names as the backend config', () => {
    expect(Object.keys(PLANS)).toEqual(Object.keys(backendPlans.PLANS));
    expect(PLAN_NAMES).toEqual(backendPlans.PLAN_NAMES);
  });

  it('has the same price and label for every plan as the backend config', () => {
    for (const name of PLAN_NAMES) {
      expect(PLANS[name].price).toBe(backendPlans.PLANS[name].price);
      expect(PLANS[name].label).toBe(backendPlans.PLANS[name].label);
    }
  });

  it('has the same annual price for every plan as the backend config', () => {
    for (const name of PLAN_NAMES) {
      expect(PLANS[name].annualPrice).toBe(backendPlans.PLANS[name].annualPrice);
    }
  });
});

// ---------------------------------------------------------------------------
// getPlanConfig
// ---------------------------------------------------------------------------
describe('getPlanConfig', () => {
  it('returns correct config for free (Enthusiast) tier', () => {
    const config = getPlanConfig('free');
    expect(config.label).toBe('Enthusiast');
    expect(config.price).toBe(0);
  });

  it('returns correct config for supporter tier', () => {
    const config = getPlanConfig('supporter');
    expect(config.label).toBe('Supporter');
    expect(config.price).toBe(2);
    expect(config.annualPrice).toBe(24);
  });

  it('returns correct config for patron tier', () => {
    const config = getPlanConfig('patron');
    expect(config.label).toBe('Patron');
    expect(config.price).toBe(5);
    expect(config.annualPrice).toBe(60);
  });

  it('returns correct config for benefactor tier', () => {
    const config = getPlanConfig('benefactor');
    expect(config.label).toBe('Benefactor');
    expect(config.price).toBe(10);
    expect(config.annualPrice).toBe(120);
  });

  it('falls back to free for unknown plan', () => {
    const config = getPlanConfig('nonexistent');
    expect(config).toEqual(PLANS.free);
  });

  it('falls back to free for undefined plan', () => {
    const config = getPlanConfig(undefined);
    expect(config).toEqual(PLANS.free);
  });

  it('falls back to free for null plan', () => {
    const config = getPlanConfig(null);
    expect(config).toEqual(PLANS.free);
  });

  it('returns an object with a featureList array', () => {
    PLAN_NAMES.forEach(plan => {
      const config = getPlanConfig(plan);
      expect(Array.isArray(config.featureList)).toBe(true);
      expect(config.featureList.length).toBeGreaterThan(0);
    });
  });

  it('returns an object with a description string', () => {
    PLAN_NAMES.forEach(plan => {
      const config = getPlanConfig(plan);
      expect(typeof config.description).toBe('string');
      expect(config.description.length).toBeGreaterThan(0);
    });
  });
});
