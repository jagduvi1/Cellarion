/**
 * Appellation spelling adoption at mint (strategy 2026-07-29, R2).
 *
 * Pins: curated spelling wins over the typed variant (by name OR synonym), an
 * un-curated appellation passes through verbatim (reviewed, never rejected),
 * a cross-country name clash only adopts when the curated spellings agree,
 * and a lookup failure never fails the mint.
 */
jest.mock('../models/Appellation', () => ({ find: jest.fn() }));

const Appellation = require('../models/Appellation');
const { resolveCanonicalAppellation } = require('./appellationResolve');

const chain = (docs) => ({
  select: jest.fn().mockReturnValue({
    limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
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
});
