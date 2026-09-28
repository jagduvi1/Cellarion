/**
 * Producer spelling canonicalization at mint (strategy 2026-07-29, R1).
 *
 * Pins the invariants: majority spelling wins, ties go to the registry's
 * oldest spelling, a brand-new producer keeps the typed spelling, quarantined
 * rows don't vote, and a lookup failure NEVER fails the mint.
 */
jest.mock('../models/WineDefinition', () => ({ aggregate: jest.fn(), find: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const { resolveCanonicalProducerSpelling, otherProducerSpellings, planProducerRename } = require('./producerSpelling');

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

// Stage 2 (2026-08-14): decoration variants — the split class stage 1 is
// blind to, found as 130 live clusters by the producer-display consolidation.
// Every guard here is a real prod case that must NOT auto-fold.
describe('resolveCanonicalProducerSpelling — decoration stage', () => {
  const COUNTRY = '69a1fbaf1356b9ede2077846'; // castable 24-hex id
  const d = (s) => new Date(s);

  test('a bare typed form adopts the registry\'s decorated spelling (same key, same country)', async () => {
    WineDefinition.aggregate
      .mockResolvedValueOnce([]) // stage 1: this exact string is new
      .mockResolvedValueOnce([{ _id: 'Weingut Philipp Kuhn', count: 5, oldest: d('2026-01-01') }]);
    const got = await resolveCanonicalProducerSpelling('Philipp Kuhn', 'philipp kuhn', { countryId: COUNTRY });
    expect(got).toBe('Weingut Philipp Kuhn');
    // The stage-2 scan is an anchored prefix on canonicalKey, country-fenced,
    // and excludes pending rows like every registry read.
    const [pipeline] = WineDefinition.aggregate.mock.calls[1];
    const match = pipeline[0].$match;
    expect(match.canonicalKey).toBeInstanceOf(RegExp);
    expect(match.canonicalKey.source.startsWith('^')).toBe(true);
    expect('philipp kuhn:riesling:pfalz').toMatch(match.canonicalKey);
    expect('philipp kuhnx:riesling:pfalz').not.toMatch(match.canonicalKey);
    expect(String(match.country)).toBe(COUNTRY);
    expect(match.pendingIdentity).toEqual({ $ne: true });
    expect(match.nonWine).toEqual({ $ne: true });
  });

  test('the reverse direction folds too: a fuller typed form adopts the registry\'s bare majority', async () => {
    // Consistency beats style here: whichever form the registry holds is the
    // one that prevents a split. (The sweep script is where the canonical
    // form itself gets changed, cluster-wide.)
    WineDefinition.aggregate
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ _id: 'Reichsrat von Buhl', count: 14, oldest: d('2026-01-01') }]);
    const got = await resolveCanonicalProducerSpelling(
      'Weingut Reichsrat von Buhl', 'weingut reichsrat von buhl', { countryId: COUNTRY });
    expect(got).toBe('Reichsrat von Buhl');
  });

  test('without a countryId the stage never runs — same-string adoption only', async () => {
    WineDefinition.aggregate.mockResolvedValueOnce([]);
    const got = await resolveCanonicalProducerSpelling('Philipp Kuhn', 'philipp kuhn');
    expect(got).toBe('Philipp Kuhn');
    expect(WineDefinition.aggregate).toHaveBeenCalledTimes(1);
  });

  test('a CONTESTED bucket adopts nothing — two spelling groups is a human call', async () => {
    // Château de Seguin (Bordeaux Sup.) and Chateau Seguin (Pessac-Léognan)
    // are two real estates sharing one producer key and one country.
    WineDefinition.aggregate
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { _id: 'Château de Seguin', count: 1, oldest: d('2026-01-01') },
        { _id: 'Chateau Seguin', count: 1, oldest: d('2026-02-01') },
      ]);
    const got = await resolveCanonicalProducerSpelling('Chateau Seguin', 'chateau seguin', { countryId: COUNTRY });
    expect(got).toBe('Chateau Seguin');
  });

  test('a typo is NOT a decoration variant — never auto-adopted', async () => {
    // "Philip Kuhn" (one L) differs in a CORE token, not decoration; folding
    // it is an identity call that belongs to a human (the near-miss queue),
    // matching the never-auto-merge rule of the canonical-collision design.
    WineDefinition.aggregate
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ _id: 'Weingut Philipp Kuhn', count: 11, oldest: d('2026-01-01') }]);
    const got = await resolveCanonicalProducerSpelling('Philip Kuhn', 'philip kuhn', { countryId: COUNTRY });
    expect(got).toBe('Philip Kuhn');
  });

  test('one group with several raw spellings adopts that group\'s majority', async () => {
    // Case variants of ONE spelling are one group — the group's own majority
    // (then oldest) picks the stored form, mirroring stage 1's rule.
    WineDefinition.aggregate
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { _id: 'FELTON ROAD', count: 1, oldest: d('2026-01-05') },
        { _id: 'Felton Road', count: 6, oldest: d('2026-01-01') },
      ]);
    const got = await resolveCanonicalProducerSpelling(
      'Felton Road Wines Ltd', 'felton road wines ltd', { countryId: COUNTRY });
    expect(got).toBe('Felton Road');
  });

  test('a stage-2 lookup failure keeps the typed spelling — the mint must not fail', async () => {
    WineDefinition.aggregate
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('db down'));
    const got = await resolveCanonicalProducerSpelling('Philipp Kuhn', 'philipp kuhn', { countryId: COUNTRY });
    expect(got).toBe('Philipp Kuhn');
  });
});

// A producer changed on an EXISTING wine never meets the mint-time resolver —
// approving producer corrections split 9 producers in the week to 2026-09-28.
// These two only report and plan; the admin picks the spelling.
describe('otherProducerSpellings', () => {
  const COUNTRY = '69a1fbaf1356b9ede2077846';
  const WINE = '69a1fbaf1356b9ede2077847';

  test('lists the other spellings in the same key + country bucket, most wines first', async () => {
    WineDefinition.aggregate.mockResolvedValue([
      { _id: 'Château Lagrézette', count: 2 },  // the spelling being stored — not "another"
      { _id: 'Chateau Lagrezette', count: 1 },
      { _id: 'Chateau  Lagrezette ', count: 1 }, // whitespace variants are one display spelling
      { _id: 'Lagrezette', count: 3 },
    ]);
    const got = await otherProducerSpellings('Château Lagrézette', COUNTRY, { excludeWineId: WINE });
    expect(got).toEqual([
      { spelling: 'Lagrezette', count: 3 },
      { spelling: 'Chateau Lagrezette', count: 2 },
    ]);
    const match = WineDefinition.aggregate.mock.calls[0][0][0].$match;
    // The bucket the registry-health metric counts: producer key prefix on
    // canonicalKey, the same country, quarantined and pending rows out.
    expect(match.canonicalKey).toBeInstanceOf(RegExp);
    expect('lagrezette:chevalier:cahors').toMatch(match.canonicalKey);
    expect('lagrezettes:x:y').not.toMatch(match.canonicalKey);
    expect(String(match.country)).toBe(COUNTRY);
    expect(match.nonWine).toEqual({ $ne: true });
    expect(match.pendingIdentity).toEqual({ $ne: true });
    expect(String(match._id.$ne)).toBe(WINE);
  });

  test('a sentinel producer, no country, or a failed lookup answers [] — it informs, never blocks', async () => {
    expect(await otherProducerSpellings('Unknown', COUNTRY)).toEqual([]);
    expect(await otherProducerSpellings('Château Lagrézette', null)).toEqual([]);
    expect(WineDefinition.aggregate).not.toHaveBeenCalled();
    WineDefinition.aggregate.mockRejectedValueOnce(new Error('db down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await otherProducerSpellings('Château Lagrézette', COUNTRY)).toEqual([]);
    warn.mockRestore();
  });
});

describe('planProducerRename', () => {
  const COUNTRY = '69a1fbaf1356b9ede2077846';
  const { generateWineKey } = require('../utils/normalize');
  const doc = (id, name, producer, appellation = 'Cahors') => ({ _id: id, name, producer, appellation });
  // find() is awaited bare for the bucket, then chained for the key check.
  const mockFinds = (bucket, taken = []) => {
    WineDefinition.find
      .mockReturnValueOnce(bucket)
      .mockReturnValueOnce({ select: () => ({ lean: async () => taken.map((k) => ({ normalizedKey: k })) }) });
  };

  test('plans every wine stored under the old spellings, with its new key', async () => {
    mockFinds([
      doc('a', 'Chevalier', 'Chateau Lagrezette'),
      doc('b', 'Le Pigeonnier', 'Lagrezette'),          // a spelling nobody asked to fold
    ]);
    const plan = await planProducerRename(['Chateau Lagrezette'], 'Château Lagrézette', COUNTRY);
    expect(plan.clashes).toEqual([]);
    expect(plan.wines.map((w) => [w.doc._id, w.from, w.newKey])).toEqual([
      ['a', 'Chateau Lagrezette', generateWineKey('Chevalier', 'Château Lagrézette', 'Cahors')],
    ]);
  });

  test('a new key another wine already holds — or the corrected wine\'s own — is a clash, not a rename', async () => {
    const own = generateWineKey('Chevalier', 'Château Lagrézette', 'Cahors');
    mockFinds([
      doc('a', 'Chevalier', 'Chateau Lagrezette'),
      doc('b', 'Le Pigeonnier', 'Chateau Lagrezette'),
    ], [generateWineKey('Le Pigeonnier', 'Château Lagrézette', 'Cahors')]);
    const plan = await planProducerRename(['Chateau Lagrezette'], 'Château Lagrézette', COUNTRY, { reservedKeys: [own] });
    expect(plan.clashes.map((c) => c.wineId).sort()).toEqual(['a', 'b']);
  });

  test('two planned wines landing on one key clash with each other', async () => {
    mockFinds([
      doc('a', 'Chevalier', 'Chateau Lagrezette'),
      doc('b', 'Chevalier', 'Chateau  Lagrezette'),
    ]);
    const plan = await planProducerRename(['Chateau Lagrezette'], 'Château Lagrézette', COUNTRY);
    expect(plan.clashes.map((c) => c.wineId)).toEqual(['b']);
  });

  test('more wines than an approval should touch is reported, not planned', async () => {
    WineDefinition.find.mockReturnValueOnce(['A', 'B', 'C'].map((n) => doc(n, n, 'Chateau Lagrezette')));
    const plan = await planProducerRename(['Chateau Lagrezette'], 'Château Lagrézette', COUNTRY, { max: 2 });
    expect(plan).toEqual({ wines: [], clashes: [], tooMany: 3 });
  });
});
