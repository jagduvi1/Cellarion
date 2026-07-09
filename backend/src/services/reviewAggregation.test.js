jest.mock('../models/Review', () => ({
  aggregate: jest.fn(),
}));
jest.mock('../models/WineDefinition', () => ({
  updateOne: jest.fn().mockResolvedValue({}),
}));

const Review = require('../models/Review');
const WineDefinition = require('../models/WineDefinition');
const {
  updateWineCommunityRating,
  buildLatestPerAuthorPipeline,
  summarizeAuthorRatings,
} = require('./reviewAggregation');

const WINE_ID = 'wine-1';

/**
 * Minimal reference executor for the exact stages the pipeline uses
 * ($match with $ne, $sort createdAt desc, $group with $first), so the
 * dedup semantics can be exercised against fixture review documents.
 */
function runPipeline(pipeline, docs) {
  let rows = [...docs];
  for (const stage of pipeline) {
    if (stage.$match) {
      const { wineDefinition, visibility } = stage.$match;
      rows = rows.filter(
        (d) => d.wineDefinition === wineDefinition && d.visibility !== visibility.$ne
      );
    } else if (stage.$sort) {
      rows = [...rows].sort((a, b) => b.createdAt - a.createdAt);
    } else if (stage.$group) {
      const groups = new Map();
      for (const d of rows) {
        const key = String(d.author);
        if (!groups.has(key)) {
          groups.set(key, { _id: d.author, rating: d.normalizedRating });
        }
      }
      rows = [...groups.values()];
    }
  }
  return rows;
}

function review(author, normalizedRating, createdAt, visibility = 'public', wineDefinition = WINE_ID) {
  return { author, normalizedRating, createdAt: new Date(createdAt), visibility, wineDefinition };
}

/** Wire the mocked Review.aggregate to run the real pipeline over fixture docs. */
function givenReviews(docs) {
  Review.aggregate.mockImplementation(async (pipeline) => runPipeline(pipeline, docs));
}

function writtenRating() {
  expect(WineDefinition.updateOne).toHaveBeenCalledTimes(1);
  const [filter, update] = WineDefinition.updateOne.mock.calls[0];
  expect(filter).toEqual({ _id: WINE_ID });
  return {
    avg: update.$set['communityRating.averageNormalized'],
    count: update.$set['communityRating.reviewCount'],
  };
}

describe('buildLatestPerAuthorPipeline', () => {
  it('sorts by createdAt desc BEFORE grouping by author with $first (latest wins)', () => {
    const pipeline = buildLatestPerAuthorPipeline(WINE_ID);
    const sortIdx = pipeline.findIndex((s) => s.$sort);
    const groupIdx = pipeline.findIndex((s) => s.$group);
    expect(pipeline[sortIdx].$sort).toEqual({ createdAt: -1 });
    expect(sortIdx).toBeLessThan(groupIdx);
    expect(pipeline[groupIdx].$group).toEqual({ _id: '$author', rating: { $first: '$normalizedRating' } });
  });

  it('matches only the wine and excludes private reviews', () => {
    const pipeline = buildLatestPerAuthorPipeline(WINE_ID);
    expect(pipeline[0].$match).toEqual({ wineDefinition: WINE_ID, visibility: { $ne: 'private' } });
  });
});

describe('summarizeAuthorRatings', () => {
  it('averages one rating per author row', () => {
    expect(summarizeAuthorRatings([
      { _id: 'a', rating: 100 },
      { _id: 'b', rating: 60 },
    ])).toEqual({ avg: 80, count: 2 });
  });

  it('returns the zero-review reset shape for an empty result', () => {
    expect(summarizeAuthorRatings([])).toEqual({ avg: null, count: 0 });
    expect(summarizeAuthorRatings(undefined)).toEqual({ avg: null, count: 0 });
  });

  it('ignores rows with non-numeric ratings', () => {
    expect(summarizeAuthorRatings([
      { _id: 'a', rating: 90 },
      { _id: 'b', rating: null },
    ])).toEqual({ avg: 90, count: 1 });
  });
});

describe('updateWineCommunityRating (author dedup — M-3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    WineDefinition.updateOne.mockResolvedValue({});
  });

  it('counts N reviews by one author exactly once, latest rating wins', async () => {
    givenReviews([
      review('forger', 100, '2026-01-01'),
      review('forger', 100, '2026-01-02'),
      review('forger', 100, '2026-01-03'),
      review('forger', 40, '2026-01-04'), // latest re-tasting
    ]);
    await updateWineCommunityRating(WINE_ID);
    expect(writtenRating()).toEqual({ avg: 40, count: 1 });
  });

  it('averages across distinct authors using each author\'s latest review', async () => {
    givenReviews([
      review('alice', 100, '2026-01-01'),
      review('alice', 80, '2026-02-01'), // alice's latest → 80
      review('bob', 60, '2026-01-15'),
      review('carol', 100, '2026-01-20'),
    ]);
    await updateWineCommunityRating(WINE_ID);
    expect(writtenRating()).toEqual({ avg: 80, count: 3 });
  });

  it('excludes private reviews — even when the private one is the latest', async () => {
    givenReviews([
      review('alice', 80, '2026-01-01'),
      review('alice', 20, '2026-02-01', 'private'), // ignored
      review('bob', 100, '2026-01-10', 'private'), // bob has no public review at all
    ]);
    await updateWineCommunityRating(WINE_ID);
    expect(writtenRating()).toEqual({ avg: 80, count: 1 });
  });

  it('only aggregates reviews of the requested wine', async () => {
    givenReviews([
      review('alice', 80, '2026-01-01'),
      review('bob', 20, '2026-01-02', 'public', 'other-wine'),
    ]);
    await updateWineCommunityRating(WINE_ID);
    expect(writtenRating()).toEqual({ avg: 80, count: 1 });
  });

  it('resets to null/0 when no public reviews remain (all deleted or private)', async () => {
    givenReviews([]);
    await updateWineCommunityRating(WINE_ID);
    expect(writtenRating()).toEqual({ avg: null, count: 0 });
  });

  it('never throws — aggregation errors are swallowed (fire-and-forget contract)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Review.aggregate.mockRejectedValue(new Error('boom'));
    await expect(updateWineCommunityRating(WINE_ID)).resolves.toBeUndefined();
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
