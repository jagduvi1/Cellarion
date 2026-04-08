import {
  PLANS,
  PLAN_NAMES,
  getPlanConfig,
  formatChatQuota,
} from './plans';

// ---------------------------------------------------------------------------
// PLAN_NAMES
// ---------------------------------------------------------------------------
describe('PLAN_NAMES', () => {
  it('contains all supporter tier keys', () => {
    expect(PLAN_NAMES).toEqual(expect.arrayContaining(['free', 'supporter', 'patron']));
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
  it('returns correct config for free (Enthusiast) tier', () => {
    const config = getPlanConfig('free');
    expect(config.label).toBe('Enthusiast');
    expect(config.price).toBe(0);
    expect(config.chatQuota).toBe(5);
  });

  it('returns correct config for supporter tier', () => {
    const config = getPlanConfig('supporter');
    expect(config.label).toBe('Supporter');
    expect(config.price).toBe(1.5);
    expect(config.chatQuota).toBe(50);
  });

  it('returns correct config for patron tier', () => {
    const config = getPlanConfig('patron');
    expect(config.label).toBe('Patron');
    expect(config.price).toBe(5.5);
    expect(config.chatQuota).toBe(-1);
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
// formatChatQuota
// ---------------------------------------------------------------------------
describe('formatChatQuota', () => {
  it('returns "Unlimited" for -1', () => {
    expect(formatChatQuota(-1)).toBe('Unlimited');
  });

  it('returns "5 / week" for 5', () => {
    expect(formatChatQuota(5)).toBe('5 / week');
  });

  it('returns "50 / week" for 50', () => {
    expect(formatChatQuota(50)).toBe('50 / week');
  });
});
