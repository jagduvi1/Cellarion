/**
 * Which tasting profile a merge keeper ends up with (routes/admin/wines.js
 * inheritAiProfile). Pins: a keeper without one inherits the best donor's (as
 * before); a curator-reviewed donor profile now REPLACES an unreviewed one on
 * the keeper and brings its review stamp along — on 2026-09-28 merging
 * "Château Mouton-Rothschild" into "Château Mouton Rothschild" threw the
 * reviewed profile away because the keeper held an old AI one; a curated
 * keeper profile is never replaced; between two unreviewed ones the keeper
 * keeps its own.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.find = jest.fn();
  ctor.findById = jest.fn();
  ctor.findOne = jest.fn();
  ctor.countDocuments = jest.fn();
  ctor.updateOne = jest.fn();
  return ctor;
});
jest.mock('../../models/Bottle', () => ({ aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/BottleImage', () => ({}));
jest.mock('../../models/WineVintageProfile', () => ({}));
jest.mock('../../models/WineVintagePrice', () => ({}));
jest.mock('../../models/WineReport', () => ({}));
jest.mock('../../models/Review', () => ({}));
jest.mock('../../models/Discussion', () => ({}));
jest.mock('../../models/DiscussionReply', () => ({}));
jest.mock('../../models/WineEmbedding', () => ({}));
jest.mock('../../models/WineNotDuplicate', () => ({ find: jest.fn() }));
jest.mock('../../models/WineList', () => ({}));
jest.mock('../../models/WishlistItem', () => ({}));
jest.mock('../../models/PriceTrackingRequest', () => ({}));
jest.mock('../../models/PriceTrackingSkip', () => ({}));
jest.mock('../../models/CommunityWinePrice', () => ({}));
jest.mock('../../models/JournalEntry', () => ({}));
jest.mock('../../models/Recommendation', () => ({}));
jest.mock('../../models/RestockAlert', () => ({}));
jest.mock('../../models/WineRequest', () => ({}));
jest.mock('../../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../../services/vectorStore', () => ({}));
jest.mock('../../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ embedSinglePair: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), removeWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const WineDefinition = require('../../models/WineDefinition');
const { inheritAiProfile } = require('./wines');

const d = (s) => new Date(s);
const ai = (description, confidence, generatedAt = '2026-08-01') => ({ description, confidence, source: 'ai', generatedAt: d(generatedAt) });

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.updateOne.mockResolvedValue({});
});

describe('inheritAiProfile', () => {
  test('a keeper without a profile inherits the most confident donor\'s', async () => {
    const keeper = { _id: 'k' };
    await inheritAiProfile(keeper, [
      { _id: 's1', aiProfile: ai('Low', 0.4) },
      { _id: 's2', aiProfile: ai('High', 0.9) },
    ]);
    expect(keeper.aiProfile.description).toBe('High');
    expect(WineDefinition.updateOne).toHaveBeenCalledWith({ _id: 'k' }, { $set: { aiProfile: expect.objectContaining({ description: 'High' }) } });
  });

  test('a curator-reviewed donor replaces the keeper\'s unreviewed AI profile, review stamp included', async () => {
    const reviewedAt = d('2026-09-20');
    const keeper = { _id: 'k', aiProfile: ai('Old AI text', 0.95) };
    const donor = { _id: 's', aiProfile: { description: 'Curated text', source: 'curator', generatedAt: d('2026-08-01') }, profileReviewedAt: reviewedAt };
    await inheritAiProfile(keeper, [donor]);
    expect(keeper.aiProfile.description).toBe('Curated text');
    expect(keeper.profileReviewedAt).toBe(reviewedAt);
    expect(WineDefinition.updateOne).toHaveBeenCalledWith({ _id: 'k' }, {
      $set: { aiProfile: expect.objectContaining({ source: 'curator' }), profileReviewedAt: reviewedAt },
    });
  });

  test('a review stamp newer than the AI profile counts as curated too', async () => {
    const keeper = { _id: 'k', aiProfile: ai('Old AI text', 0.95) };
    const donor = { _id: 's', aiProfile: ai('Reviewed AI text', 0.5, '2026-08-01'), profileReviewedAt: d('2026-08-02') };
    await inheritAiProfile(keeper, [donor]);
    expect(keeper.aiProfile.description).toBe('Reviewed AI text');
  });

  test('a curated keeper profile is never replaced', async () => {
    const keeper = { _id: 'k', aiProfile: { description: 'Keeper curated', source: 'curator' } };
    await inheritAiProfile(keeper, [{ _id: 's', aiProfile: { description: 'Donor curated', source: 'curator' } }]);
    expect(keeper.aiProfile.description).toBe('Keeper curated');
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });

  test('between two unreviewed profiles the keeper keeps its own', async () => {
    const keeper = { _id: 'k', aiProfile: ai('Keeper AI', 0.2) };
    await inheritAiProfile(keeper, [{ _id: 's', aiProfile: ai('Donor AI', 0.9), profileReviewedAt: d('2026-07-01') }]);
    expect(keeper.aiProfile.description).toBe('Keeper AI');
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });
});
