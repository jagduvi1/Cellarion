/**
 * Producer spelling canonicalization at mint (strategy 2026-07-29, R1).
 *
 * Pins the invariants: majority spelling wins, ties go to the registry's
 * oldest spelling, a brand-new producer keeps the typed spelling, quarantined
 * rows don't vote, and a lookup failure NEVER fails the mint.
 */
jest.mock('../models/WineDefinition', () => ({ aggregate: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const { resolveCanonicalProducerSpelling } = require('./producerSpelling');

beforeEach(() => jest.clearAllMocks());

describe('resolveCanonicalProducerSpelling', () => {
  test('adopts the majority spelling over the typed variant', async () => {
    // The aggregate is $sort/$limit'd server-side; the mock returns the winner.
    WineDefinition.aggregate.mockResolvedValue([
      { _id: 'Cave de Ribeauvillé', count: 12, oldest: new Date('2026-01-01') },
    ]);
    const got = await resolveCanonicalProducerSpelling('Cave de Ribeauville', 'cave de ribeauville');
    expect(got).toBe('Cave de Ribeauvillé');
  });

  test('a producer new to the registry keeps the typed spelling', async () => {
    WineDefinition.aggregate.mockResolvedValue([]);
    const got = await resolveCanonicalProducerSpelling('Château Neuf', 'chateau neuf');
    expect(got).toBe('Château Neuf');
  });

  test('the query is an anchored prefix on normalizedKey and excludes quarantined rows', async () => {
    WineDefinition.aggregate.mockResolvedValue([]);
    await resolveCanonicalProducerSpelling('Léoville Barton', 'leoville barton');
    const [pipeline] = WineDefinition.aggregate.mock.calls[0];
    const match = pipeline[0].$match;
    expect(match.normalizedKey).toBeInstanceOf(RegExp);
    expect(match.normalizedKey.source.startsWith('^')).toBe(true);
    // The ':' terminator keeps "domaine x" from matching "domaine xy".
    expect(match.normalizedKey.source.endsWith(':')).toBe(true);
    expect('leoville barton:pauillac wine:x').toMatch(match.normalizedKey);
    expect('leoville bartonx:wine:x').not.toMatch(match.normalizedKey);
    expect(match.nonWine).toEqual({ $ne: true });
    // Majority-then-oldest is the SAME rule scripts/unify-producer-spellings.js
    // applies — mint-time and cleanup must agree or they'd fight.
    expect(pipeline.find(s => s.$sort)).toEqual({ $sort: { count: -1, oldest: 1 } });
  });

  test('an empty normalized producer short-circuits without querying', async () => {
    const got = await resolveCanonicalProducerSpelling('??', '');
    expect(got).toBe('??');
    expect(WineDefinition.aggregate).not.toHaveBeenCalled();
  });

  test('a lookup failure keeps the typed spelling — a mint must not fail over a display nicety', async () => {
    WineDefinition.aggregate.mockRejectedValue(new Error('db down'));
    const got = await resolveCanonicalProducerSpelling('Guigal', 'guigal');
    expect(got).toBe('Guigal');
  });

  test('regex special characters in the producer are escaped, not interpreted', async () => {
    WineDefinition.aggregate.mockResolvedValue([]);
    await resolveCanonicalProducerSpelling('R. López (Heredia)', 'r lopez heredia');
    const [pipeline] = WineDefinition.aggregate.mock.calls[0];
    // normalizeString strips punctuation, but the escape must hold even for a
    // caller that passes a rawer norm — the guard is in this function, not its
    // callers.
    expect(() => new RegExp(pipeline[0].$match.normalizedKey)).not.toThrow();
  });
});
