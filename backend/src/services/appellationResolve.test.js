/**
 * Appellation spelling adoption at mint (strategy 2026-07-29, R2).
 *
 * Pins: curated spelling wins over the typed variant (by name OR synonym), an
 * un-curated appellation passes through verbatim (reviewed, never rejected),
 * a cross-country name clash only adopts when the curated spellings agree,
 * and a lookup failure never fails the mint.
 *
 * Plus the MEMBERSHIP GATE on decoration stripping: the resolver retries with
 * "DO" / "Appellation … Contrôlée" removed, but only ADOPTS a stripped variant
 * that a curated doc actually carries — and adopts the DOC's spelling, never
 * the stripped raw string. That gate is the whole safety argument for
 * stripping tokens utils/normalize deliberately leaves alone.
 */
jest.mock('../models/Appellation', () => ({ find: jest.fn() }));

const Appellation = require('../models/Appellation');
const { resolveCanonicalAppellation } = require('./appellationResolve');

const chain = (docs) => ({
  select: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
    }),
  }),
});

beforeEach(() => jest.clearAllMocks());

describe('resolveCanonicalAppellation', () => {
  test('adopts the curated spelling when the taxonomy knows the appellation', async () => {
    Appellation.find.mockReturnValue(chain([{ name: 'Châteauneuf-du-Pape' }]));
    expect(await resolveCanonicalAppellation('Chateauneuf du Pape')).toBe('Châteauneuf-du-Pape');
    // The lookup matches by normalized name OR synonym — one query, both axes.
    const q = Appellation.find.mock.calls[0][0];
    expect(q.$or).toEqual([
      { normalizedName: 'chateauneuf du pape' },
      { normalizedSynonyms: 'chateauneuf du pape' },
    ]);
  });

  // The reason normalizeAppellationKey exists: normalizeString DELETES
  // hyphens, so the hyphenated and spaced forms of one place produced two
  // different keys — found on the first prod-data test of this resolver.
  test('hyphenated and spaced forms produce the SAME lookup key', async () => {
    Appellation.find.mockReturnValue(chain([{ name: 'Châteauneuf-du-Pape' }]));
    await resolveCanonicalAppellation('Châteauneuf-du-Pape');
    const hyphenQ = Appellation.find.mock.calls[0][0].$or[0].normalizedName;
    Appellation.find.mockClear();
    Appellation.find.mockReturnValue(chain([{ name: 'Châteauneuf-du-Pape' }]));
    await resolveCanonicalAppellation('Chateauneuf du Pape');
    const spacedQ = Appellation.find.mock.calls[0][0].$or[0].normalizedName;
    expect(hyphenQ).toBe(spacedQ);
    expect(hyphenQ).toBe('chateauneuf du pape');
  });

  test('an un-curated appellation passes through verbatim — reviewed, never rejected', async () => {
    Appellation.find.mockReturnValue(chain([]));
    expect(await resolveCanonicalAppellation('Vin de Garage de Jean')).toBe('Vin de Garage de Jean');
  });

  test('two curated docs with the SAME display spelling still adopt it', async () => {
    // Same name in two countries (the unique index is per-country).
    Appellation.find.mockReturnValue(chain([{ name: 'Moscato' }, { name: 'Moscato' }]));
    expect(await resolveCanonicalAppellation('moscato')).toBe('Moscato');
  });

  test('two curated docs that DISAGREE on spelling leave the input alone', async () => {
    Appellation.find.mockReturnValue(chain([{ name: 'Moscato' }, { name: 'Moscatel' }]));
    expect(await resolveCanonicalAppellation('moscato')).toBe('moscato');
  });

  test('empty input short-circuits without querying', async () => {
    expect(await resolveCanonicalAppellation('')).toBe('');
    expect(Appellation.find).not.toHaveBeenCalled();
  });

  test('a lookup failure keeps the input — a mint must not fail over taxonomy', async () => {
    Appellation.find.mockImplementation(() => { throw new Error('db down'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await resolveCanonicalAppellation('Barolo')).toBe('Barolo');
    warn.mockRestore();
  });

  test('a synonym adopts the canonical name', async () => {
    Appellation.find.mockReturnValue(chain([{ name: 'Châteauneuf-du-Pape' }]));
    expect(await resolveCanonicalAppellation('CDP')).toBe('Châteauneuf-du-Pape');
    expect(Appellation.find.mock.calls[0][0].$or[1]).toEqual({ normalizedSynonyms: 'cdp' });
  });
});

/**
 * Trailing "DO" and the "Appellation … Contrôlée" wrapper are decorations
 * utils/normalize cannot strip blindly — 'do' collides with real place-name
 * words, and the wrapper's payload IS the appellation. The resolver may strip
 * them because membership decides: no curated doc, no adoption.
 */
describe('membership-gated decoration stripping', () => {
  // A curated key sequence: exact first, then the stripped variants in order.
  const findByKey = (byKey) => {
    Appellation.find.mockImplementation((q) => chain(byKey[q.$or[0].normalizedName] || []));
  };

  test('"Yecla DO" adopts the curated "Yecla" — the prod case that motivated this', async () => {
    findByKey({ yecla: [{ name: 'Yecla' }] });
    expect(await resolveCanonicalAppellation('Yecla DO')).toBe('Yecla');
    // The exact string is tried FIRST; only its miss licenses the strip.
    expect(Appellation.find.mock.calls.map(c => c[0].$or[0].normalizedName)).toEqual(['yecla do', 'yecla']);
  });

  test('THE GATE: "Yecla DO" stays verbatim when no doc carries "Yecla"', async () => {
    findByKey({});
    expect(await resolveCanonicalAppellation('Yecla DO')).toBe('Yecla DO');
  });

  // The gate is what makes the aggressive strip safe: a real appellation whose
  // last word happens to be "do" simply matches nothing stripped and survives.
  test('THE GATE: a real name ending in "do" is not mutilated', async () => {
    findByKey({ 'lisboa do': [{ name: 'Lisboa DO' }] });
    expect(await resolveCanonicalAppellation('Lisboa DO')).toBe('Lisboa DO');
    expect(Appellation.find).toHaveBeenCalledTimes(1); // exact hit, no strip attempted
  });

  test('the AOC wrapper is stripped when the payload is curated', async () => {
    findByKey({ bordeaux: [{ name: 'Bordeaux' }] });
    expect(await resolveCanonicalAppellation('Appellation Bordeaux Contrôlée')).toBe('Bordeaux');
  });

  test('the unaccented and Protégée wrapper forms fold to the same variant', async () => {
    findByKey({ bordeaux: [{ name: 'Bordeaux' }] });
    expect(await resolveCanonicalAppellation('Appellation Bordeaux Controlee')).toBe('Bordeaux');
    expect(await resolveCanonicalAppellation("Appellation d'Origine Bordeaux Protégée")).toBe('Bordeaux');
  });

  test('both decorations at once', async () => {
    findByKey({ yecla: [{ name: 'Yecla' }] });
    expect(await resolveCanonicalAppellation('Appellation Yecla DO Contrôlée')).toBe('Yecla');
  });

  test('what is stored is the DOC\'s spelling, never the stripped raw string', async () => {
    findByKey({ yecla: [{ name: 'Yecla DOP' }] }); // curated spelling keeps its own mark
    expect(await resolveCanonicalAppellation('yecla do')).toBe('Yecla DOP');
  });

  test('the agree-all rule holds per variant — disagreeing docs keep the input', async () => {
    findByKey({ yecla: [{ name: 'Yecla' }, { name: 'Iecla' }] });
    expect(await resolveCanonicalAppellation('Yecla DO')).toBe('Yecla DO');
  });

  test('a KNOWN exact key that disagrees stops there — no stripping past a match', async () => {
    findByKey({ 'yecla do': [{ name: 'Yecla DO' }, { name: 'Yecla D.O.' }], yecla: [{ name: 'Yecla' }] });
    expect(await resolveCanonicalAppellation('Yecla DO')).toBe('Yecla DO');
    expect(Appellation.find).toHaveBeenCalledTimes(1);
  });

  test('an undecorated miss costs exactly one query — no speculative variants', async () => {
    findByKey({});
    expect(await resolveCanonicalAppellation('Vin de Garage de Jean')).toBe('Vin de Garage de Jean');
    expect(Appellation.find).toHaveBeenCalledTimes(1);
  });
});

/**
 * appellationHasGeography (somm 6a8eb2a9): the producer-suspect narrowing's
 * predicate. Deliberately about the curated ENTRY's geography, not the field
 * being populated — the somm's counter-examples pin both failure modes:
 * "Vin de France" (curated, nationwide, region null) and "Qualitätswein"
 * (a tier, not curated) must both return false.
 */
const { appellationHasGeography } = require('./appellationResolve');

describe('appellationHasGeography', () => {
  const geoChain = (docs) => ({
    select: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
      }),
    }),
  });

  test('curated entry with a region → true', async () => {
    Appellation.find.mockReturnValue(geoChain([{ region: 'r'.repeat(24) }]));
    await expect(appellationHasGeography('Châteauneuf-du-Pape')).resolves.toBe(true);
  });

  test('curated but nationwide (region null) → false — "Vin de France"', async () => {
    Appellation.find.mockReturnValue(geoChain([{ region: null }]));
    await expect(appellationHasGeography('Vin de France')).resolves.toBe(false);
  });

  test('not curated at all → false — "Qualitätswein"', async () => {
    Appellation.find.mockReturnValue(geoChain([]));
    await expect(appellationHasGeography('Qualitätswein')).resolves.toBe(false);
  });

  test('cross-country namesakes must ALL carry geography', async () => {
    Appellation.find.mockReturnValue(geoChain([{ region: 'r'.repeat(24) }, { region: null }]));
    await expect(appellationHasGeography('Ambiguous')).resolves.toBe(false);
  });

  test('empty / null input → false', async () => {
    await expect(appellationHasGeography('')).resolves.toBe(false);
    await expect(appellationHasGeography(null)).resolves.toBe(false);
  });

  test('a lookup failure keeps the flag: false, never a throw', async () => {
    Appellation.find.mockImplementation(() => { throw new Error('db down'); });
    await expect(appellationHasGeography('Sauternes')).resolves.toBe(false);
  });
});
