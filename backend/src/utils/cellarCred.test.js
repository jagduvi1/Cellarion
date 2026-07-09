jest.mock('../models/User', () => ({
  findByIdAndUpdate: jest.fn(),
  updateOne: jest.fn(),
}));

const User = require('../models/User');
const { getTier, getSpecialty, POINT_VALUES, CATEGORY_MAP, incrementCred, decrementCred } = require('./cellarCred');

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

// Helper: extract { totalDelta, catPath, catDelta } from the aggregation-
// pipeline update passed to findByIdAndUpdate. The pipeline shape is
// [{ $set: { 'contribution.totalScore': { $max: [0, { $add: [<ifNull>, delta] }] }, <catPath>: … } }]
function pipelineDeltas() {
  const [, update] = User.findByIdAndUpdate.mock.calls[0];
  expect(Array.isArray(update)).toBe(true); // aggregation pipeline, not $inc
  const set = update[0].$set;
  const totalDelta = set['contribution.totalScore'].$max[1].$add[1];
  const catPath = Object.keys(set).find(k => k.startsWith('contribution.categories.'));
  const catDelta = set[catPath].$max[1].$add[1];
  return { totalDelta, catPath, catDelta, set };
}

describe('symmetric cred accounting (L-19)', () => {
  beforeEach(() => jest.clearAllMocks());

  const freshContribution = (totalScore, categories, tier, specialty = null) => ({
    contribution: { totalScore, categories, tier, specialty },
  });

  it('incrementCred applies +points to total and category, clamped at 0 via $max', async () => {
    User.findByIdAndUpdate.mockResolvedValue(
      freshContribution(3, { curator: 0, photographer: 0, critic: 3, community: 0 }, 'newcomer', 'critic')
    );

    await incrementCred('user123', 'review_created_public');

    const { totalDelta, catPath, catDelta, set } = pipelineDeltas();
    expect(totalDelta).toBe(POINT_VALUES.review_created_public);
    expect(catPath).toBe('contribution.categories.critic');
    expect(catDelta).toBe(POINT_VALUES.review_created_public);
    // Clamp: both counters are wrapped in $max against 0
    expect(set['contribution.totalScore'].$max[0]).toBe(0);
    expect(set[catPath].$max[0]).toBe(0);
  });

  it('decrementCred reverses exactly what the event awarded', async () => {
    User.findByIdAndUpdate.mockResolvedValue(
      freshContribution(0, { curator: 0, photographer: 0, critic: 0, community: 0 }, 'newcomer')
    );

    await decrementCred('user123', 'reply_like_received');

    const { totalDelta, catPath, catDelta } = pipelineDeltas();
    expect(totalDelta).toBe(-POINT_VALUES.reply_like_received);
    expect(catPath).toBe('contribution.categories.community');
    expect(catDelta).toBe(-POINT_VALUES.reply_like_received);
  });

  it('decrementCred supports a count multiplier and always subtracts (sign-safe)', async () => {
    User.findByIdAndUpdate.mockResolvedValue(
      freshContribution(0, { curator: 0, photographer: 0, critic: 0, community: 0 }, 'newcomer')
    );

    await decrementCred('user123', 'review_like_received', 7);
    let deltas = pipelineDeltas();
    expect(deltas.totalDelta).toBe(-7 * POINT_VALUES.review_like_received);

    jest.clearAllMocks();
    User.findByIdAndUpdate.mockResolvedValue(
      freshContribution(0, { curator: 0, photographer: 0, critic: 0, community: 0 }, 'newcomer')
    );
    // A negative count must not flip a decrement into an award
    await decrementCred('user123', 'review_like_received', -7);
    deltas = pipelineDeltas();
    expect(deltas.totalDelta).toBe(-7 * POINT_VALUES.review_like_received);
  });

  it('decrementCred recomputes the tier downward when a threshold is crossed', async () => {
    // After the reversal the user sits at 24 — back below the contributor line
    User.findByIdAndUpdate.mockResolvedValue(
      freshContribution(24, { curator: 0, photographer: 0, critic: 24, community: 0 }, 'contributor', 'critic')
    );
    User.updateOne.mockResolvedValue({});

    await decrementCred('user123', 'review_created_public');

    expect(User.updateOne).toHaveBeenCalledTimes(1);
    const [, updateOp] = User.updateOne.mock.calls[0];
    expect(updateOp.$set['contribution.tier']).toBe('newcomer');
  });

  it('is a no-op for unknown events and zero counts', async () => {
    await decrementCred('user123', 'not_a_real_event');
    await decrementCred('user123', 'review_like_received', 0);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
