/**
 * unpolluteEstateName — the estate-name pollution guard (ticket 6a83f014).
 *
 * Four Bordeaux classed growths arrived as name "Grand Cru Classé (de
 * Graves)" / "Margaux" with the château in producer. The guard's precision
 * rules ARE the feature: négociant and Burgundy-domaine appellation-names are
 * legitimate and must never match, and the narrow classification vocabulary
 * must not eat real name material (Reserva, bare Premier Cru).
 */
jest.mock('../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn(); ctor.find = jest.fn(); ctor.aggregate = jest.fn();
  return ctor;
});
jest.mock('../models/Country', () => ({ findOne: jest.fn(), find: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Region', () => ({ findOne: jest.fn(), find: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Grape', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/Appellation', () => ({ exists: jest.fn(), find: jest.fn() }));
jest.mock('./search', () => ({ getIsAvailable: jest.fn(), search: jest.fn(), indexWine: jest.fn() }));
jest.mock('./wineMatching', () => ({ scoreAllMatches: jest.fn() }));
jest.mock('./grapeInference', () => ({ buildSurfaceForms: jest.fn(), inferGrapeIds: jest.fn() }));
jest.mock('./producerSpelling', () => ({ resolveCanonicalProducerSpelling: jest.fn() }));

const Appellation = require('../models/Appellation');
const { unpolluteEstateName } = require('./findOrCreateWine');

// The resolver's lookup chain (resolveCanonicalAppellation → Appellation.find)
const findChain = (docs) => ({
  select: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
    }),
  }),
});

beforeEach(() => {
  jest.clearAllMocks();
  Appellation.exists.mockResolvedValue(null);
  Appellation.find.mockReturnValue(findChain([]));
});

describe('shape (a): the entire name is a classed-growth phrase', () => {
  test.each([
    'Grand Cru Classé',
    'Grand Cru Classé de Graves',
    'Cru Bourgeois',
    '4ème Cru Classé',
    '1er Grand Cru Classé',
    'grand cru classe', // unaccented import data
  ])('"%s" moves to classification, name falls back to the estate', async (bad) => {
    const out = await unpolluteEstateName({
      name: bad, producer: 'Château Pape Clément', appellation: null, classification: null,
    });
    expect(out.changed).toBe('classification_as_name');
    expect(out.name).toBe('Château Pape Clément');
    expect(out.classification).toBe(bad);
  });

  test('an existing classification is never overwritten by the shifted name', async () => {
    const out = await unpolluteEstateName({
      name: 'Grand Cru Classé', producer: 'Château Talbot', appellation: 'Saint-Julien', classification: '4ème Cru Classé',
    });
    expect(out.classification).toBe('4ème Cru Classé');
    expect(out.name).toBe('Château Talbot');
  });

  test('real name material is NOT in the vocabulary: Reserva, Riserva, bare Premier Cru', async () => {
    for (const legit of ['Reserva', 'Riserva', 'Premier Cru', 'Gran Reserva']) {
      const out = await unpolluteEstateName({
        name: legit, producer: 'Marqués de Riscal', appellation: null, classification: null,
      });
      expect(out.changed).toBe(false);
      expect(out.name).toBe(legit);
    }
  });
});

describe('shape (b): château producer + curated-appellation name', () => {
  test('name "Margaux" on Château du Tertre becomes the estate name + appellation', async () => {
    Appellation.exists.mockResolvedValue({ _id: 'x' });
    Appellation.find.mockReturnValue(findChain([{ name: 'Margaux' }]));
    const out = await unpolluteEstateName({
      name: 'Margaux', producer: 'Château du Tertre', appellation: null, classification: null,
    });
    expect(out.changed).toBe('appellation_as_name');
    expect(out.name).toBe('Château du Tertre');
    expect(out.appellation).toBe('Margaux');
  });

  test('a populated appellation is kept, not overwritten (the Phélan Ségur shape)', async () => {
    Appellation.exists.mockResolvedValue({ _id: 'x' });
    const out = await unpolluteEstateName({
      name: 'Saint Estephe', producer: 'Chateau Phelan Segur', appellation: 'Saint-Estèphe', classification: null,
    });
    expect(out.changed).toBe('appellation_as_name');
    expect(out.name).toBe('Chateau Phelan Segur');
    expect(out.appellation).toBe('Saint-Estèphe');
  });

  test('NÉGOCIANT appellation-names never match — the gate is the château word', async () => {
    Appellation.exists.mockResolvedValue({ _id: 'x' }); // even though the doc exists
    const out = await unpolluteEstateName({
      name: 'Chassagne-Montrachet', producer: 'Louis Jadot', appellation: null, classification: null,
    });
    expect(out.changed).toBe(false);
    expect(Appellation.exists).not.toHaveBeenCalled();
  });

  test('Burgundy DOMAINES keep appellation-names too — domaine is deliberately not in the gate', async () => {
    Appellation.exists.mockResolvedValue({ _id: 'x' });
    const out = await unpolluteEstateName({
      name: 'Gevrey-Chambertin', producer: 'Domaine Rossignol-Trapet', appellation: null, classification: null,
    });
    expect(out.changed).toBe(false);
  });

  test('a château name that matches NO curated appellation passes through (a real cuvée)', async () => {
    Appellation.exists.mockResolvedValue(null);
    const out = await unpolluteEstateName({
      name: 'Les Forts de Latour', producer: 'Château Latour', appellation: null, classification: null,
    });
    expect(out.changed).toBe(false);
    expect(out.name).toBe('Les Forts de Latour');
  });
});

describe('pass-through shapes', () => {
  test('the estate form itself (name === producer) is already canon — untouched', async () => {
    const out = await unpolluteEstateName({
      name: 'Château Talbot', producer: 'Château Talbot', appellation: null, classification: null,
    });
    expect(out.changed).toBe(false);
  });

  test('missing producer or name never rewrites', async () => {
    expect((await unpolluteEstateName({ name: 'Margaux', producer: '', appellation: null, classification: null })).changed).toBe(false);
    expect((await unpolluteEstateName({ name: '', producer: 'Château X', appellation: null, classification: null })).changed).toBe(false);
  });
});
