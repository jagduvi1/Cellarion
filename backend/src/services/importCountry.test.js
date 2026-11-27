/**
 * services/importCountry — the country of an import row whose file states
 * none.
 *
 * WHY THIS TEST EXISTS:
 * A wine cannot be stored without a country, so a row with none can only
 * become a wine request. The registry often knows the answer, and may supply
 * it only when it is sure: one country for the appellation, else for the
 * region, else for the producer's published wines. A name two countries share
 * settles nothing, a region only a member's own add created is not evidence,
 * and a failed look-up leaves the row as it was.
 */
jest.mock('../models/Appellation', () => ({ find: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn() }));
jest.mock('../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ distinct: jest.fn() }));
jest.mock('./audit', () => ({ logger: { warn: jest.fn() } }));

const Appellation = require('../models/Appellation');
const Region = require('../models/Region');
const Country = require('../models/Country');
const WineDefinition = require('../models/WineDefinition');
const { logger } = require('./audit');
const { deriveCountryName, withDerivedCountry } = require('./importCountry');

const NAMES = { it: 'Italy', de: 'Germany', es: 'Spain', pt: 'Portugal' };
const docs = (list) => ({ select: () => ({ limit: () => ({ lean: async () => list }) }) });

beforeEach(() => {
  jest.clearAllMocks();
  Appellation.find.mockReturnValue(docs([]));
  Region.find.mockReturnValue(docs([]));
  WineDefinition.distinct.mockResolvedValue([]);
  Country.findById.mockImplementation((id) => ({ select: () => ({ lean: async () => (NAMES[id] ? { name: NAMES[id] } : null) }) }));
});

test('the appellation settles it, matched by name or synonym', async () => {
  Appellation.find.mockReturnValue(docs([{ country: 'it' }]));
  expect(await deriveCountryName({ appellation: 'Barolo DOCG', region: 'Mosel', producer: 'Anyone' })).toBe('Italy');
  const [filter] = Appellation.find.mock.calls[0];
  expect(filter.$or).toEqual([{ normalizedName: expect.any(String) }, { normalizedSynonyms: expect.any(String) }]);
  // The first source that answers wins: nothing else is asked.
  expect(Region.find).not.toHaveBeenCalled();
  expect(WineDefinition.distinct).not.toHaveBeenCalled();
});

test('an appellation name two countries share settles nothing; the region is asked next', async () => {
  Appellation.find.mockReturnValue(docs([{ country: 'es' }, { country: 'pt' }]));
  Region.find.mockReturnValue(docs([{ country: 'de' }]));
  expect(await deriveCountryName({ appellation: 'Monterrei', region: 'Mosel' })).toBe('Germany');
});

test('only a region a curator seeded or reviewed is asked: a member\'s own add is not evidence', async () => {
  Region.find.mockReturnValue(docs([{ country: 'de' }]));
  await deriveCountryName({ region: 'Mosel' });
  const [filter] = Region.find.mock.calls[0];
  expect(filter.$and[1]).toEqual({ $or: [{ createdByUser: { $ne: true } }, { reviewedAt: { $ne: null } }] });
});

test('last, the producer: every published wine of that producer is in one country', async () => {
  WineDefinition.distinct.mockResolvedValue(['it']);
  expect(await deriveCountryName({ producer: 'Cantina Esempio' })).toBe('Italy');
  const [field, filter] = WineDefinition.distinct.mock.calls[0];
  expect(field).toBe('country');
  expect(filter.normalizedKey.source).toBe('^cantina esempio:');
  expect(filter).toMatchObject({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } });
});

test('a producer with wines in two countries settles nothing, and a placeholder producer is not asked', async () => {
  WineDefinition.distinct.mockResolvedValue(['es', 'pt']);
  expect(await deriveCountryName({ producer: 'Bodegas Dos' })).toBeNull();
  WineDefinition.distinct.mockClear();
  expect(await deriveCountryName({ producer: 'Unknown' })).toBeNull();
  expect(WineDefinition.distinct).not.toHaveBeenCalled();
});

test('a row that states nothing to go on derives nothing', async () => {
  expect(await deriveCountryName({})).toBeNull();
  expect(await deriveCountryName()).toBeNull();
});

test('a failed look-up derives nothing and is logged, never thrown', async () => {
  Appellation.find.mockImplementation(() => { throw new Error('db down'); });
  expect(await deriveCountryName({ appellation: 'Barolo' })).toBeNull();
  expect(logger.warn).toHaveBeenCalledTimes(1);
});

describe('withDerivedCountry', () => {
  test('fills in the country of an identity that has none', async () => {
    Appellation.find.mockReturnValue(docs([{ country: 'it' }]));
    const identity = { name: 'Barolo Bussia', producer: 'Cantina Esempio', country: null, appellation: 'Barolo' };
    expect(await withDerivedCountry(identity)).toEqual({ ...identity, country: 'Italy' });
  });

  test('leaves alone an identity that states its country, one nothing settles, and none at all', async () => {
    const stated = { name: 'X', producer: 'Y', country: 'France', appellation: 'Barolo' };
    expect(await withDerivedCountry(stated)).toBe(stated);
    expect(Appellation.find).not.toHaveBeenCalled();

    const unknown = { name: 'X', producer: 'Y', country: null };
    expect(await withDerivedCountry(unknown)).toBe(unknown);
    expect(await withDerivedCountry(null)).toBeNull();
  });
});
