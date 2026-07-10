import {
  PLANS,
  PLAN_NAMES,
  getPlanConfig,
} from './plans';
import backendPlans from '../../../backend/src/config/plans.js';

// ---------------------------------------------------------------------------
// PLAN_NAMES
// ---------------------------------------------------------------------------
describe('PLAN_NAMES', () => {
  it('contains all supporter tier keys', () => {
    expect(PLAN_NAMES).toEqual(expect.arrayContaining(['free', 'supporter', 'patron']));
    expect(PLAN_NAMES).toHaveLength(3);
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
    expect(config.price).toBe(1.5);
  });

  it('returns correct config for patron tier', () => {
    const config = getPlanConfig('patron');
    expect(config.label).toBe('Patron');
    expect(config.price).toBe(5.5);
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
