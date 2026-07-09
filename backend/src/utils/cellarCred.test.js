jest.mock('../models/User', () => ({
  findByIdAndUpdate: jest.fn(),
  updateOne: jest.fn(),
}));

const User = require('../models/User');
const { getTier, getSpecialty, POINT_VALUES, CATEGORY_MAP, incrementCred } = require('./cellarCred');

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

describe('incrementCred — no plan rewards', () => {
  beforeEach(() => jest.clearAllMocks());

  it('recomputes the badge tier but never grants a plan when crossing a threshold', async () => {
    // User who, after this increment, has crossed the connoisseur threshold (>=300)
    User.findByIdAndUpdate.mockResolvedValue({
      contribution: {
        totalScore: 305,
        categories: { curator: 0, photographer: 305, critic: 0, community: 0 },
        tier: 'enthusiast',        // stale — should be bumped to connoisseur
        specialty: 'photographer', // unchanged
      },
      plan: 'free',
      planExpiresAt: null,
    });
    User.updateOne.mockResolvedValue({});

    await incrementCred('user123', 'image_approved');

    expect(User.updateOne).toHaveBeenCalledTimes(1);
    const [, updateOp] = User.updateOne.mock.calls[0];
    const set = updateOp.$set || {};

    // Badge still recomputed
    expect(set['contribution.tier']).toBe('connoisseur');
    // But the subscription is left completely alone
    expect(set).not.toHaveProperty('plan');
    expect(set).not.toHaveProperty('planStartedAt');
    expect(set).not.toHaveProperty('planExpiresAt');
    expect(updateOp).not.toHaveProperty('$addToSet'); // no rewardsGranted writes
  });

  it('is a no-op write when neither tier nor specialty changes', async () => {
    User.findByIdAndUpdate.mockResolvedValue({
      contribution: {
        totalScore: 40,
        categories: { curator: 0, photographer: 40, critic: 0, community: 0 },
        tier: 'contributor',
        specialty: 'photographer',
      },
      plan: 'free',
      planExpiresAt: null,
    });

    await incrementCred('user123', 'image_approved');

    expect(User.updateOne).not.toHaveBeenCalled();
  });
});
