/**
 * statsService maturity coverage + forecast (BUG 5).
 *
 * WHY THIS TEST EXISTS:
 * classifyMaturity prefers a bottle's PERSONAL drink window (drinkFrom/drinkTo)
 * over the sommelier profile. Two knock-on bugs followed:
 *   1. maturityCoverage.sommSet ("N with sommelier profiles") was incremented for
 *      personal-window bottles that have NO reviewed profile — an overcount.
 *   2. the 10-year forecast used profile years even when a personal window
 *      governed the bucket, and excluded personal-only bottles entirely — so the
 *      forecast disagreed with the phase buckets.
 *
 * Chosen semantics (documented in statsService.js):
 *   - sommSet  = bottles that actually have a reviewed sommelier profile.
 *   - none     = bottles with NO signal at all (no personal window, no profile).
 *   - personal-only bottles count toward NEITHER coverage bucket but still land
 *     in a phase bucket and the forecast, using their personal years.
 *
 * Models / rate snapshot are mocked so no MongoDB is needed.
 */

jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  convertCurrency: jest.fn((amt) => amt),
}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));

const { computeOverview } = require('./statsService');
const WineVintageProfile = require('../models/WineVintageProfile');

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-06-15T00:00:00Z'));
});
afterAll(() => jest.useRealTimers());

beforeEach(() => jest.clearAllMocks());

const runOverview = (activeBottles, profiles = []) => {
  // buildProfileMap issues one find({...}).lean(); return the given reviewed profiles.
  WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve(profiles) });
  return computeOverview({
    activeBottles,
    consumedBottles: [],
    cellars: [{ _id: 'c1', name: 'Main' }],
    targetCurrency: 'USD',
    targetRatingScale: '100',
  });
};

const forecastByYear = (stats) => Object.fromEntries(stats.maturityForecast.map((d) => [d.year, d.count]));

describe('maturityCoverage.sommSet (BUG 5)', () => {
  test('a personal-window bottle with NO profile is NOT counted as sommSet', async () => {
    const stats = await runOverview([
      { cellar: 'c1', vintage: '2018', drinkFrom: 2024, drinkTo: 2028, wineDefinition: { _id: 'wd1' } },
    ]);
    expect(stats.maturity.peak).toBe(1);        // classified via the personal window
    expect(stats.maturityCoverage.sommSet).toBe(0); // but NOT a sommelier profile
    expect(stats.maturityCoverage.none).toBe(0);    // and not "without data" either
  });

  test('a bottle with a reviewed profile IS counted as sommSet', async () => {
    const stats = await runOverview(
      [{ cellar: 'c1', vintage: '2019', wineDefinition: { _id: 'wd2' } }],
      [{ wineDefinition: 'wd2', vintage: '2019', status: 'reviewed', peakFrom: 2025, peakUntil: 2030 }],
    );
    expect(stats.maturity.peak).toBe(1);
    expect(stats.maturityCoverage.sommSet).toBe(1);
    expect(stats.maturityCoverage.none).toBe(0);
  });

  test('a bottle with neither a personal window nor a profile is "without data" (none)', async () => {
    const stats = await runOverview([
      { cellar: 'c1', vintage: '2019', wineDefinition: { _id: 'wd3' } },
    ]);
    expect(stats.maturity.noProfile).toBe(1);
    expect(stats.maturityCoverage.none).toBe(1);
    expect(stats.maturityCoverage.sommSet).toBe(0);
  });

  test('a reviewed-but-empty profile (no window boundaries) is NOT sommSet and lands in noProfile', async () => {
    // The bottle must not be counted "with a sommelier profile" while it shows in
    // the No Profile segment — that would be an internal contradiction.
    const stats = await runOverview(
      [{ cellar: 'c1', vintage: '2019', wineDefinition: { _id: 'wd4' } }],
      [{ wineDefinition: 'wd4', vintage: '2019', status: 'reviewed', sommNotes: 'reviewed but no window' }],
    );
    expect(stats.maturity.noProfile).toBe(1);
    expect(stats.maturityCoverage.sommSet).toBe(0);
    expect(stats.maturityCoverage.none).toBe(1);
  });
});

describe('urgencyLadder bottle id (HA consume support)', () => {
  test('urgency items carry the bottle id so API consumers can act on them', async () => {
    const stats = await runOverview([
      // drinkTo in the past → 'declining' → lands on the urgency ladder
      { _id: 'b1', cellar: 'c1', vintage: '2015', drinkFrom: 2016, drinkTo: 2020, wineDefinition: { _id: 'wd1', name: 'Old Red' } },
    ]);
    expect(stats.urgencyLadder).toHaveLength(1);
    expect(stats.urgencyLadder[0].id).toBe('b1');
    expect(stats.urgencyLadder[0].name).toBe('Old Red');
  });

  test('a bottle without _id omits the id field instead of crashing', async () => {
    const stats = await runOverview([
      { cellar: 'c1', vintage: '2015', drinkFrom: 2016, drinkTo: 2020, wineDefinition: { _id: 'wd1' } },
    ]);
    expect(stats.urgencyLadder).toHaveLength(1);
    expect(stats.urgencyLadder[0].id).toBeUndefined();
  });
});

describe('maturityForecast personal-window consistency (BUG 5)', () => {
  test('a personal-only bottle is included in the forecast using its own years', async () => {
    const stats = await runOverview([
      { cellar: 'c1', vintage: '2018', drinkFrom: 2024, drinkTo: 2028, wineDefinition: { _id: 'wd1' } },
    ]);
    expect(stats.maturity.peak).toBe(1);
    const byYear = forecastByYear(stats);
    expect(byYear[2026]).toBe(1); // inside 2024–2028
    expect(byYear[2028]).toBe(1); // last in-window year
    expect(byYear[2029]).toBe(0); // past drinkTo
  });

  test('a personal override on a profiled wine uses the personal years, not the profile years', async () => {
    const stats = await runOverview(
      [{ cellar: 'c1', vintage: '2019', drinkFrom: 2031, drinkTo: 2033, wineDefinition: { _id: 'wd2' } }],
      [{ wineDefinition: 'wd2', vintage: '2019', status: 'reviewed', peakFrom: 2025, peakUntil: 2030 }],
    );
    // Personal window governs the bucket (not-ready in 2026) …
    expect(stats.maturity.notReady).toBe(1);
    // … the wine still HAS a reviewed profile, so it honestly counts as sommSet …
    expect(stats.maturityCoverage.sommSet).toBe(1);
    // … but the forecast uses the personal 2031–2033 window, not the profile 2025–2030.
    const byYear = forecastByYear(stats);
    expect(byYear[2026]).toBe(0);
    expect(byYear[2031]).toBe(1);
    expect(byYear[2033]).toBe(1);
    expect(byYear[2034]).toBe(0);
  });

  test('a profile-only bottle still forecasts from its profile window', async () => {
    const stats = await runOverview(
      [{ cellar: 'c1', vintage: '2019', wineDefinition: { _id: 'wd2' } }],
      [{ wineDefinition: 'wd2', vintage: '2019', status: 'reviewed', peakFrom: 2027, peakUntil: 2029 }],
    );
    const byYear = forecastByYear(stats);
    expect(byYear[2026]).toBe(0);
    expect(byYear[2027]).toBe(1);
    expect(byYear[2029]).toBe(1);
    expect(byYear[2030]).toBe(0);
  });
});
