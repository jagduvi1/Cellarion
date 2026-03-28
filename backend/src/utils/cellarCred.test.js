const { getTier, getSpecialty, POINT_VALUES, CATEGORY_MAP } = require('./cellarCred');

describe('getTier', () => {
  it('returns newcomer for 0', () => expect(getTier(0)).toBe('newcomer'));
  it('returns newcomer for 24', () => expect(getTier(24)).toBe('newcomer'));
  it('returns contributor for 25', () => expect(getTier(25)).toBe('contributor'));
  it('returns enthusiast for 100', () => expect(getTier(100)).toBe('enthusiast'));
  it('returns connoisseur for 300', () => expect(getTier(300)).toBe('connoisseur'));
  it('returns ambassador for 750', () => expect(getTier(750)).toBe('ambassador'));
  it('returns ambassador for 9999', () => expect(getTier(9999)).toBe('ambassador'));
});

describe('getSpecialty', () => {
  it('returns null for zero scores', () => {
    expect(getSpecialty({ curator: 0, photographer: 0, critic: 0, community: 0 })).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(getSpecialty(undefined)).toBeNull();
  });

  it('returns top category when dominant', () => {
    expect(getSpecialty({ curator: 50, photographer: 5, critic: 5, community: 5 })).toBe('curator');
    expect(getSpecialty({ curator: 0, photographer: 30, critic: 2, community: 1 })).toBe('photographer');
  });

  it('returns allrounder when no category >40%', () => {
    expect(getSpecialty({ curator: 25, photographer: 25, critic: 25, community: 25 })).toBe('allrounder');
    expect(getSpecialty({ curator: 30, photographer: 30, critic: 20, community: 20 })).toBe('allrounder');
  });
});

describe('constants', () => {
  it('every event has a point value', () => {
    for (const key of Object.keys(CATEGORY_MAP)) {
      expect(POINT_VALUES[key]).toBeGreaterThan(0);
    }
  });

  it('every event maps to a valid category', () => {
    const validCategories = ['curator', 'photographer', 'critic', 'community'];
    for (const cat of Object.values(CATEGORY_MAP)) {
      expect(validCategories).toContain(cat);
    }
  });
});
