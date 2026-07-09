/**
 * Guards the L-15 retention promise: external recipientEmail (third-party PII
 * with no account-based erasure path) is blanked after 90 days while the
 * user-visible recommendation document itself is kept.
 */
jest.mock('../models/Recommendation', () => ({
  updateMany: jest.fn(),
}));

const Recommendation = require('../models/Recommendation');
const {
  runRecommendationEmailScrub,
  RECIPIENT_EMAIL_RETENTION_DAYS,
} = require('./recommendationRetentionJob');

describe('runRecommendationEmailScrub (L-15)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('unsets recipientEmail only on external recs older than the retention window', async () => {
    Recommendation.updateMany.mockResolvedValue({ modifiedCount: 4 });

    const before = Date.now();
    const result = await runRecommendationEmailScrub();
    const after = Date.now();

    expect(Recommendation.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = Recommendation.updateMany.mock.calls[0];

    // Field is blanked, document is NOT deleted
    expect(update).toEqual({ $unset: { recipientEmail: '' } });

    // Only rows that still carry an email and are past the 90-day cutoff
    expect(filter.recipientEmail).toEqual({ $ne: null });
    const windowMs = RECIPIENT_EMAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(RECIPIENT_EMAIL_RETENTION_DAYS).toBe(90);
    expect(filter.createdAt.$lt.getTime()).toBeGreaterThanOrEqual(before - windowMs);
    expect(filter.createdAt.$lt.getTime()).toBeLessThanOrEqual(after - windowMs);

    expect(result).toEqual({ scrubbed: 4 });
  });

  it('reports zero when nothing is old enough', async () => {
    Recommendation.updateMany.mockResolvedValue({ modifiedCount: 0 });
    await expect(runRecommendationEmailScrub()).resolves.toEqual({ scrubbed: 0 });
  });
});
