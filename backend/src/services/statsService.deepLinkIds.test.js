/**
 * The stats payload carries the ids the Analytics page needs to link a row to
 * the record it names (forum request, turbulent3964 2026-08-29).
 *
 * The urgency ladder already carried `id` (added for the Home Assistant card);
 * these pin the two that were missing — topValueBottles and cellarBreakdown —
 * so a future refactor of the projection can't quietly drop them and turn the
 * links back into plain text.
 */

jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue({ rates: null }),
  // Identity conversion keeps the assertions about ids, not currency math.
  convertCurrency: jest.fn((amount) => amount),
}));
jest.mock('../utils/maturityUtils', () => ({
  buildProfileMap: jest.fn().mockResolvedValue(new Map()),
  classifyMaturity: jest.fn(() => null),
  classifyPersonalWindow: jest.fn(() => null),
  resolveWindowForBottle: jest.fn(() => null),
}));

const { computeOverview } = require('./statsService');

const CELLAR_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CELLAR_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const bottle = (over = {}) => ({
  _id: { toString: () => over._idStr || 'bottle-1' },
  cellar: { toString: () => CELLAR_A },
  price: 100,
  currency: 'EUR',
  vintage: 2018,
  wineDefinition: { _id: { toString: () => 'wine-1' }, name: 'Barolo', producer: 'Vietti', type: 'red' },
  ...over,
});

const run = (activeBottles, cellars = [{ _id: { toString: () => CELLAR_A }, name: 'Main Cellar' }]) =>
  computeOverview({
    activeBottles, consumedBottles: [], cellars,
    targetCurrency: 'EUR', targetRatingScale: '5',
  });

describe('stats payload ids for Analytics deep links', () => {
  // BOTH ids: a bottle's page is /cellars/:cellarId/bottles/:bottleId, so the
  // bottle id alone cannot address it (the first cut of this feature linked to
  // a /bottles/:id route that does not exist).
  test('topValueBottles carries the bottle id AND its cellar id', async () => {
    const stats = await run([bottle({ _idStr: 'bottle-9' })]);
    expect(stats.topValueBottles).toHaveLength(1);
    expect(stats.topValueBottles[0]).toMatchObject({
      id: 'bottle-9', cellarId: CELLAR_A, name: 'Barolo', producer: 'Vietti',
    });
  });

  test('cellarBreakdown carries the cellar id, matching the bottles grouped under it', async () => {
    const stats = await run([bottle()]);
    expect(stats.cellarBreakdown).toHaveLength(1);
    expect(stats.cellarBreakdown[0]).toMatchObject({ id: CELLAR_A, name: 'Main Cellar', bottleCount: 1 });
  });

  test('a cellar missing from the fetched list still gets an id (the group key IS the id)', async () => {
    // Defensive: the name falls back to 'Cellar', but a link must still work —
    // otherwise the one row whose doc wasn't loaded is the one that can't be
    // opened.
    const stats = await run([bottle({ cellar: { toString: () => CELLAR_B } })], []);
    expect(stats.cellarBreakdown[0]).toMatchObject({ id: CELLAR_B, name: 'Cellar' });
  });

  test('urgencyLadder carries both ids too — the "Drink These Now" link', async () => {
    const { classifyMaturity } = require('../utils/maturityUtils');
    classifyMaturity.mockReturnValueOnce('declining');
    const stats = await run([bottle({ _idStr: 'bottle-urgent' })]);
    expect(stats.urgencyLadder).toHaveLength(1);
    expect(stats.urgencyLadder[0]).toMatchObject({ id: 'bottle-urgent', cellarId: CELLAR_A });
  });

  test('an unpriced bottle contributes no top-value row (unchanged behaviour)', async () => {
    const stats = await run([bottle({ price: null })]);
    expect(stats.topValueBottles).toHaveLength(0);
    // …but it still counts toward its cellar, which keeps its id.
    expect(stats.cellarBreakdown[0]).toMatchObject({ id: CELLAR_A, bottleCount: 1 });
  });
});
