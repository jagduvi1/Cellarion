import {
  PLANS,
  PLAN_NAMES,
  getPlanConfig,
  planHasFeature,
  formatLimit,
} from './plans';

// ---------------------------------------------------------------------------
// PLAN_NAMES
// ---------------------------------------------------------------------------
describe('PLAN_NAMES', () => {
  it('contains all plan keys', () => {
    expect(PLAN_NAMES).toEqual(expect.arrayContaining(['free', 'basic', 'premium']));
    expect(PLAN_NAMES).toHaveLength(3);
  });

  it('matches the keys of the PLANS object', () => {
    expect(PLAN_NAMES).toEqual(Object.keys(PLANS));
  });
});

// ---------------------------------------------------------------------------
// getPlanConfig
// ---------------------------------------------------------------------------
describe('getPlanConfig', () => {
  it('returns correct config for free plan', () => {
    const config = getPlanConfig('free');
    expect(config.label).toBe('Free');
    expect(config.maxCellars).toBe(1);
    expect(config.maxSharesPerCellar).toBe(1);
    expect(config.features.agingMaturity).toBe(true);
    expect(config.features.priceEvolution).toBe(false);
  });

  it('returns correct config for basic plan', () => {
    const config = getPlanConfig('basic');
    expect(config.label).toBe('Basic');
    expect(config.maxCellars).toBe(5);
    expect(config.maxSharesPerCellar).toBe(1);
    expect(config.features.agingMaturity).toBe(true);
    expect(config.features.priceEvolution).toBe(false);
  });

  it('returns correct config for premium plan', () => {
    const config = getPlanConfig('premium');
    expect(config.label).toBe('Premium');
    expect(config.maxCellars).toBe(-1);
    expect(config.maxSharesPerCellar).toBe(-1);
    expect(config.features.agingMaturity).toBe(true);
    expect(config.features.priceEvolution).toBe(true);
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

// ---------------------------------------------------------------------------
// planHasFeature
// ---------------------------------------------------------------------------
describe('planHasFeature', () => {
  it('returns true for premium agingMaturity', () => {
    expect(planHasFeature('premium', 'agingMaturity')).toBe(true);
  });

  it('returns true for premium priceEvolution', () => {
    expect(planHasFeature('premium', 'priceEvolution')).toBe(true);
  });

  it('returns true for free agingMaturity', () => {
    expect(planHasFeature('free', 'agingMaturity')).toBe(true);
  });

  it('returns false for free priceEvolution', () => {
    expect(planHasFeature('free', 'priceEvolution')).toBe(false);
  });

  it('returns true for basic agingMaturity', () => {
    expect(planHasFeature('basic', 'agingMaturity')).toBe(true);
  });

  it('returns false for basic priceEvolution', () => {
    expect(planHasFeature('basic', 'priceEvolution')).toBe(false);
  });

  it('returns true for free restockAlerts', () => {
    expect(planHasFeature('free', 'restockAlerts')).toBe(true);
  });

  it('returns true for basic restockAlerts', () => {
    expect(planHasFeature('basic', 'restockAlerts')).toBe(true);
  });

  it('returns true for premium restockAlerts', () => {
    expect(planHasFeature('premium', 'restockAlerts')).toBe(true);
  });

  it('returns false for unknown feature on any plan', () => {
    expect(planHasFeature('premium', 'nonexistentFeature')).toBe(false);
  });

  it('falls back to free plan for unknown plan name', () => {
    // Unknown plan -> free config -> agingMaturity is now true
    expect(planHasFeature('nonexistent', 'agingMaturity')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatLimit
// ---------------------------------------------------------------------------
describe('formatLimit', () => {
  it('returns "Unlimited" for -1', () => {
    expect(formatLimit(-1)).toBe('Unlimited');
  });

  it('returns string "1" for 1', () => {
    expect(formatLimit(1)).toBe('1');
  });

  it('returns string "5" for 5', () => {
    expect(formatLimit(5)).toBe('5');
  });

  it('returns string "0" for 0', () => {
    expect(formatLimit(0)).toBe('0');
  });

  it('returns string for large number', () => {
    expect(formatLimit(100)).toBe('100');
  });

  it('always returns a string for positive numbers', () => {
    const result = formatLimit(42);
    expect(typeof result).toBe('string');
  });
});
