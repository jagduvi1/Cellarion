/**
 * taxonomyMerge — the merge order IS the safety property:
 *   - references are rewritten BEFORE the duplicate is deleted
 *   - array swaps are $addToSet-then-$pull (a wine may already hold both ids)
 *   - the duplicate's name+synonyms land in the canonical doc's synonyms so
 *     findOrCreate* can never re-mint it
 *   - country merges never move a colliding region (unique {country,
 *     normalizedName} index) — they fold it into the existing one
 *
 * Models are mocked; normalizeString is the real implementation so synonym
 * dedup (diacritics, case) is tested for real.
 */
jest.mock('../models/WineDefinition', () => ({
  find: jest.fn(),
  updateMany: jest.fn(),
}));
jest.mock('../models/Country', () => ({ findById: jest.fn() }));
jest.mock('../models/Region', () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  updateMany: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../models/Grape', () => ({ findById: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/Appellation', () => ({ updateMany: jest.fn() }));
jest.mock('./search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined) }));

const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const searchService = require('./search');
const { mergeGrapes, mergeRegions, mergeCountries } = require('./taxonomyMerge');

const doc = (over = {}) => ({
  _id: over._id || 'id',
  name: 'Name',
  synonyms: [],
  save: jest.fn().mockResolvedValue(undefined),
  deleteOne: jest.fn().mockResolvedValue(undefined),
  ...over,
});

// WineDefinition.find(...).select('_id').lean() → wine id docs
const primeAffectedWines = (ids) => {
  WineDefinition.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(ids.map(_id => ({ _id }))) }),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.updateMany.mockResolvedValue({ modifiedCount: 0 });
  Region.updateMany.mockResolvedValue({ modifiedCount: 0 });
  Region.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Grape.updateMany.mockResolvedValue({ modifiedCount: 0 });
  Appellation.updateMany.mockResolvedValue({ modifiedCount: 0 });
  primeAffectedWines([]);
});

describe('mergeGrapes', () => {
  test('rejects merging a grape into itself', async () => {
    await expect(mergeGrapes('g1', 'g1')).rejects.toMatchObject({ status: 400 });
    expect(Grape.findById).not.toHaveBeenCalled();
  });

  test('404s when either doc is missing', async () => {
    Grape.findById.mockResolvedValueOnce(null).mockResolvedValueOnce(doc({ _id: 'g2' }));
    await expect(mergeGrapes('g1', 'g2')).rejects.toMatchObject({ status: 404 });
  });

  test('rewrites wines addToSet-then-pull, absorbs synonyms, deletes duplicate, reindexes', async () => {
    const from = doc({ _id: 'g-dup', name: 'Pinot Nero', synonyms: ['Blauburgunder'], color: 'Red' });
    const to = doc({ _id: 'g-canon', name: 'Pinot Noir', synonyms: [], color: null });
    Grape.findById.mockImplementation(id => Promise.resolve(id === 'g-dup' ? from : to));
    primeAffectedWines(['w1', 'w2']);

    const summary = await mergeGrapes('g-dup', 'g-canon');

    // addToSet strictly before pull — order guards wines that hold both ids
    const calls = WineDefinition.updateMany.mock.calls;
    expect(calls[0]).toEqual([{ grapes: 'g-dup' }, { $addToSet: { grapes: 'g-canon' } }]);
    expect(calls[1]).toEqual([{ grapes: 'g-dup' }, { $pull: { grapes: 'g-dup' } }]);

    // both region grape arrays get the same two-step swap
    expect(Region.updateMany).toHaveBeenCalledWith({ typicalGrapes: 'g-dup' }, { $addToSet: { typicalGrapes: 'g-canon' } });
    expect(Region.updateMany).toHaveBeenCalledWith({ permittedGrapes: 'g-dup' }, { $pull: { permittedGrapes: 'g-dup' } });

    expect(to.synonyms).toEqual(['Pinot Nero', 'Blauburgunder']);
    expect(to.color).toBe('Red'); // enrichment backfilled, never overwritten
    expect(to.save).toHaveBeenCalled();
    expect(from.deleteOne).toHaveBeenCalled();
    expect(searchService.indexWine).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ winesUpdated: 2, synonymsAdded: ['Pinot Nero', 'Blauburgunder'] });
  });

  test('does not duplicate the canonical name or existing synonyms (diacritic-insensitive)', async () => {
    const from = doc({ _id: 'g-dup', name: 'Carinena', synonyms: ['Mazuelo'] });
    const to = doc({ _id: 'g-canon', name: 'Carignan', synonyms: ['Cariñena'] });
    Grape.findById.mockImplementation(id => Promise.resolve(id === 'g-dup' ? from : to));

    const summary = await mergeGrapes('g-dup', 'g-canon');

    // "Carinena" normalizes to existing synonym "Cariñena" → skipped
    expect(summary.synonymsAdded).toEqual(['Mazuelo']);
    expect(to.synonyms).toEqual(['Cariñena', 'Mazuelo']);
  });

  test('synonyms:false drops the duplicate name instead of absorbing it (junk names)', async () => {
    const from = doc({ _id: 'g-dup', name: '70% Monastrell' });
    const to = doc({ _id: 'g-canon', name: 'Mourvèdre', synonyms: ['Monastrell'] });
    Grape.findById.mockImplementation(id => Promise.resolve(id === 'g-dup' ? from : to));

    const summary = await mergeGrapes('g-dup', 'g-canon', { synonyms: false });

    expect(summary.synonymsAdded).toEqual([]);
    expect(to.synonyms).toEqual(['Monastrell']);
    expect(from.deleteOne).toHaveBeenCalled();
  });

  test('resync:false skips search reindex', async () => {
    const from = doc({ _id: 'g-dup', name: 'Durif' });
    const to = doc({ _id: 'g-canon', name: 'Petite Sirah' });
    Grape.findById.mockImplementation(id => Promise.resolve(id === 'g-dup' ? from : to));
    primeAffectedWines(['w1']);

    await mergeGrapes('g-dup', 'g-canon', { resync: false });
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  // Audit 2026-08-11: regionalNames are display data about the VARIETY — a
  // merge that dropped them silently lost curated labels.
  test('carries the duplicate\'s regionalNames, skipping (country, region) pairs the canonical doc already covers', async () => {
    const from = doc({
      _id: 'g-dup', name: 'Pinot Nero',
      regionalNames: [
        { country: 'c-pt', region: 'r-douro', name: 'Tinta Roriz' },   // new pair → carried
        { country: 'c-pt', region: null, name: 'Aragonez' },           // country-level pair taken → skipped
      ],
    });
    const to = doc({
      _id: 'g-canon', name: 'Pinot Noir',
      regionalNames: [{ country: 'c-pt', region: null, name: 'Aragonês' }],
    });
    Grape.findById.mockImplementation(id => Promise.resolve(id === 'g-dup' ? from : to));

    await mergeGrapes('g-dup', 'g-canon');

    expect(to.regionalNames).toEqual([
      { country: 'c-pt', region: null, name: 'Aragonês' },
      { country: 'c-pt', region: 'r-douro', name: 'Tinta Roriz' },
    ]);
    expect(to.save).toHaveBeenCalled();
  });

  test('regionalNames carry onto a canonical doc that had none', async () => {
    const from = doc({
      _id: 'g-dup', name: 'Pinot Nero',
      regionalNames: [{ country: 'c-it', region: null, name: 'Pinot Nero' }],
    });
    const to = doc({ _id: 'g-canon', name: 'Pinot Noir' }); // no regionalNames field at all
    Grape.findById.mockImplementation(id => Promise.resolve(id === 'g-dup' ? from : to));

    await mergeGrapes('g-dup', 'g-canon');

    expect(to.regionalNames).toEqual([{ country: 'c-it', region: null, name: 'Pinot Nero' }]);
  });
});

describe('mergeRegions', () => {
  const rdoc = (over) => doc({ country: 'c-fr', classification: null, prestigeLevel: null,
    description: '', styles: [], typicalGrapes: [], permittedGrapes: [], ...over });

  test('refuses cross-country merges', async () => {
    const from = rdoc({ _id: 'r1', country: 'c-fr' });
    const to = rdoc({ _id: 'r2', country: 'c-it' });
    Region.findById.mockImplementation(id => Promise.resolve(id === 'r1' ? from : to));
    await expect(mergeRegions('r1', 'r2')).rejects.toMatchObject({ status: 400 });
    expect(from.deleteOne).not.toHaveBeenCalled();
  });

  test('rewrites wines, child regions and appellations, then deletes', async () => {
    const from = rdoc({ _id: 'r-dup', name: 'Piemonte', description: 'Nebbiolo country', typicalGrapes: ['g1'] });
    const to = rdoc({ _id: 'r-canon', name: 'Piedmont', typicalGrapes: ['g1', 'g2'] });
    Region.findById.mockImplementation(id => Promise.resolve(id === 'r-dup' ? from : to));
    Region.updateMany.mockResolvedValue({ modifiedCount: 3 });
    Appellation.updateMany.mockResolvedValue({ modifiedCount: 1 });
    primeAffectedWines(['w1']);

    const summary = await mergeRegions('r-dup', 'r-canon');

    expect(WineDefinition.updateMany).toHaveBeenCalledWith({ region: 'r-dup' }, { $set: { region: 'r-canon' } });
    expect(Region.updateMany).toHaveBeenCalledWith({ parentRegion: 'r-dup' }, { $set: { parentRegion: 'r-canon' } });
    expect(Appellation.updateMany).toHaveBeenCalledWith({ region: 'r-dup' }, { $set: { region: 'r-canon' } });
    expect(to.synonyms).toEqual(['Piemonte']);
    expect(to.description).toBe('Nebbiolo country'); // backfilled
    expect(to.typicalGrapes).toEqual(['g1', 'g2']);  // union, no dupes
    expect(from.deleteOne).toHaveBeenCalled();
    expect(summary).toMatchObject({ winesUpdated: 1, childRegionsUpdated: 3, appellationsUpdated: 1 });
  });

  // Audit 2026-08-11: grape regionalNames scope to regions — a merge must
  // re-point them like every other region ref or resolution silently stops.
  test('re-points Grape.regionalNames.region via arrayFilters', async () => {
    const from = rdoc({ _id: 'r-dup', name: 'Piemonte' });
    const to = rdoc({ _id: 'r-canon', name: 'Piedmont' });
    Region.findById.mockImplementation(id => Promise.resolve(id === 'r-dup' ? from : to));

    await mergeRegions('r-dup', 'r-canon');

    expect(Grape.updateMany).toHaveBeenCalledWith(
      { 'regionalNames.region': 'r-dup' },
      { $set: { 'regionalNames.$[e].region': 'r-canon' } },
      { arrayFilters: [{ 'e.region': 'r-dup' }] }
    );
  });
});

describe('mergeRegions synonyms:false', () => {
  test('junk region names are dropped instead of absorbed', async () => {
    const from = doc({ _id: 'r-junk', name: 'Mosel or Rheingau', country: 'c-de',
      styles: [], typicalGrapes: [], permittedGrapes: [] });
    const to = doc({ _id: 'r-canon', name: 'Mosel', country: 'c-de',
      styles: [], typicalGrapes: [], permittedGrapes: [] });
    Region.findById.mockImplementation(id => Promise.resolve(id === 'r-junk' ? from : to));

    const summary = await mergeRegions('r-junk', 'r-canon', { synonyms: false });

    expect(summary.synonymsAdded).toEqual([]);
    expect(to.synonyms).toEqual([]);
    expect(from.deleteOne).toHaveBeenCalled();
  });
});

describe('mergeCountries', () => {
  test('moves non-colliding regions, folds colliding ones, rewrites wines + appellations', async () => {
    const from = doc({ _id: 'c-dup', name: 'Unknown' });
    const to = doc({ _id: 'c-canon', name: 'Japan' });
    Country.findById.mockImplementation(id => Promise.resolve(id === 'c-dup' ? from : to));

    const moved = doc({ _id: 'r-moved', name: 'Kansai', normalizedName: 'kansai', country: 'c-dup',
      styles: [], typicalGrapes: [], permittedGrapes: [] });
    const colliding = doc({ _id: 'r-coll', name: 'Hokkaido', normalizedName: 'hokkaido', country: 'c-dup',
      styles: [], typicalGrapes: [], permittedGrapes: [] });
    const existing = doc({ _id: 'r-existing', name: 'Hokkaido', normalizedName: 'hokkaido', country: 'c-canon',
      styles: [], typicalGrapes: [], permittedGrapes: [], synonyms: [] });
    Region.find.mockResolvedValue([moved, colliding]);
    Region.findOne.mockImplementation(q =>
      Promise.resolve(q.normalizedName === 'hokkaido' ? existing : null));
    primeAffectedWines(['w1', 'w2', 'w3']);

    const summary = await mergeCountries('c-dup', 'c-canon');

    // non-colliding region re-parented in place
    expect(Region.updateOne).toHaveBeenCalledWith({ _id: 'r-moved' }, { $set: { country: 'c-canon' } });
    // colliding region folded into the existing doc — never moved (unique index)
    expect(Region.updateOne).not.toHaveBeenCalledWith({ _id: 'r-coll' }, expect.anything());
    expect(colliding.deleteOne).toHaveBeenCalled();
    expect(WineDefinition.updateMany).toHaveBeenCalledWith({ region: 'r-coll' }, { $set: { region: 'r-existing' } });

    expect(WineDefinition.updateMany).toHaveBeenCalledWith({ country: 'c-dup' }, { $set: { country: 'c-canon' } });
    expect(Appellation.updateMany).toHaveBeenCalledWith({ country: 'c-dup' }, { $set: { country: 'c-canon' } });
    expect(from.deleteOne).toHaveBeenCalled();
    expect(summary).toMatchObject({ winesUpdated: 3, regionsMoved: 1, regionsMerged: 1 });

    // Audit 2026-08-11: country-level grape regionalNames follow the merge —
    // and the folded colliding region re-pointed its region-level entries too
    // (mergeRegionDocs runs for it).
    expect(Grape.updateMany).toHaveBeenCalledWith(
      { 'regionalNames.country': 'c-dup' },
      { $set: { 'regionalNames.$[e].country': 'c-canon' } },
      { arrayFilters: [{ 'e.country': 'c-dup' }] }
    );
    expect(Grape.updateMany).toHaveBeenCalledWith(
      { 'regionalNames.region': 'r-coll' },
      { $set: { 'regionalNames.$[e].region': 'r-existing' } },
      { arrayFilters: [{ 'e.region': 'r-coll' }] }
    );
  });
});
