/**
 * Guards the registry-pollution defenses of findOrCreateWine — this code path
 * previously auto-created ~430 junk registry entries, so the threshold routing
 * IS the feature:
 *
 *   exact normalizedKey match          → return existing, never create
 *   fuzzy score >= 0.95                → auto-match existing (>= — exactly 0.95 matches)
 *   0.85 <= score < 0.95 (soft zone)   → { wine: null, candidates } "did you mean?",
 *                                        never a silent create (unless confirmCreate)
 *   score < 0.85                       → create a new registry entry
 *
 * The scorer (wineMatching.scoreAllMatches) is mocked so the boundary values
 * can be pinned exactly; wineMatching has its own dedicated suites. The
 * normalize utils (generateWineKey, normalizeString, resolveGrapeName) are the
 * REAL implementations, so key generation and grape-synonym dedup are tested
 * for real.
 */
jest.mock('../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  return ctor;
});
jest.mock('../models/Country', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../models/Region', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../models/Grape', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('./search', () => ({
  getIsAvailable: jest.fn(),
  search: jest.fn(),
  indexWine: jest.fn(),
}));
jest.mock('./wineMatching', () => ({ scoreAllMatches: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const searchService = require('./search');
const { scoreAllMatches } = require('./wineMatching');
const { generateWineKey } = require('../utils/normalize');
const {
  findOrCreateWine,
  findOrCreateCountry,
  findOrCreateRegion,
  findOrCreateGrapes,
} = require('./findOrCreateWine');

const USER_ID = 'user-1';
const POPULATE = ['country', 'region', 'grapes'];

const INPUT = {
  name: 'Clos des Papes',
  producer: 'Paul Avril',
  country: 'France',
  region: 'Rhône',
  appellation: 'Châteauneuf-du-Pape',
  type: 'red',
  grapes: ['Grenache', 'Syrah'],
};
const INPUT_KEY = generateWineKey('Clos des Papes', 'Paul Avril', 'Châteauneuf-du-Pape');

const EXISTING_WINE = { _id: 'wine-existing', name: 'Clos des Papes' };

// findOne(...).populate(...) — populate resolves to the doc or null
const findOneChain = (doc) => ({ populate: jest.fn().mockResolvedValue(doc) });
// find($text...).populate(...).limit(20) — the MongoDB text-search fallback
const textSearchChain = (docs) => ({
  populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(docs) }),
});

/** Prime the Meilisearch path with ranked results the mocked scorer returns. */
function primeCandidates(ranked) {
  const candidates = ranked.map((r) => r.wine);
  searchService.getIsAvailable.mockReturnValue(true);
  searchService.search.mockResolvedValue({ ids: candidates.map((c) => c._id) });
  // find({ _id: { $in: ids } }).populate(POPULATE) — awaited directly
  WineDefinition.find.mockReturnValue({ populate: jest.fn().mockResolvedValue(candidates) });
  scoreAllMatches.mockReturnValue(ranked);
}

let warnSpy;

beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  // Instance mocks: constructor assigns the doc, save/populate resolve to self
  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
  });
  for (const [Model, prefix] of [[Country, 'country'], [Region, 'region'], [Grape, 'grape']]) {
    Model.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this._id = `${prefix}-new`;
      this.save = jest.fn().mockResolvedValue(this);
    });
  }

  // Defaults: no exact match, Meilisearch down, text fallback empty → create path
  WineDefinition.findOne.mockReturnValue(findOneChain(null));
  searchService.getIsAvailable.mockReturnValue(false);
  WineDefinition.find.mockReturnValue(textSearchChain([]));
  scoreAllMatches.mockReturnValue([]);

  // Taxonomy defaults: everything already exists
  Country.findOne.mockResolvedValue({ _id: 'country-1' });
  Region.findOne.mockResolvedValue({ _id: 'region-1' });
  // findOrCreateGrapes queries { $or: [{ normalizedName }, { normalizedSynonyms: … }] }
  Grape.findOne.mockImplementation(async (q) => {
    const normalizedName = q.$or ? q.$or[0].normalizedName : q.normalizedName;
    return { _id: `grape-${normalizedName}` };
  });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('findOrCreateWine — exact match', () => {
  test('exact normalizedKey match returns the existing wine, no create, no fuzzy search', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(EXISTING_WINE));

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: INPUT_KEY });
    expect(result).toEqual({ wine: EXISTING_WINE, created: false });
    expect(WineDefinition).not.toHaveBeenCalled(); // no constructor call
    expect(searchService.search).not.toHaveBeenCalled();
    expect(scoreAllMatches).not.toHaveBeenCalled();
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  test('name/producer/appellation are trimmed before key generation', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(EXISTING_WINE));

    await findOrCreateWine(
      { ...INPUT, name: '  Clos des Papes  ', producer: ' Paul Avril ', appellation: ' Châteauneuf-du-Pape ' },
      USER_ID
    );

    expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: INPUT_KEY });
  });
});

describe('findOrCreateWine — fuzzy threshold routing', () => {
  test('score above 0.95 auto-matches the top-ranked wine, no create', async () => {
    primeCandidates([{ wine: EXISTING_WINE, score: 0.97 }]);

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(result).toEqual({ wine: EXISTING_WINE, created: false });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('score of EXACTLY 0.95 auto-matches (comparison is >=, not >)', async () => {
    primeCandidates([{ wine: EXISTING_WINE, score: 0.95 }]);

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(result).toEqual({ wine: EXISTING_WINE, created: false });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('score just below 0.95 falls into the soft zone — "did you mean?", no silent create', async () => {
    primeCandidates([{ wine: EXISTING_WINE, score: 0.9499 }]);

    const result = await findOrCreateWine(INPUT, USER_ID);

    // Routing uses the RAW score (0.9499 < 0.95 → soft zone, no auto-match);
    // the candidate's display score is rounded to 2 decimals AFTERWARDS, so it
    // can legitimately show 0.95 even though the wine did not auto-match.
    expect(result).toEqual({
      wine: null,
      candidates: [{ wine: EXISTING_WINE, score: 0.95 }],
    });
    expect(WineDefinition).not.toHaveBeenCalled();
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  test('score of EXACTLY 0.85 is still in the soft zone (comparison is >=)', async () => {
    primeCandidates([{ wine: EXISTING_WINE, score: 0.85 }]);

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(result).toEqual({
      wine: null,
      candidates: [{ wine: EXISTING_WINE, score: 0.85 }],
    });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('score just below 0.85 creates a new registry entry', async () => {
    primeCandidates([{ wine: EXISTING_WINE, score: 0.8499 }]);

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(result.created).toBe(true);
    expect(WineDefinition).toHaveBeenCalledTimes(1);
  });

  test('soft zone returns at most 5 candidates, filtered to >= 0.85, scores rounded', async () => {
    const ranked = [
      { wine: { _id: 'w1' }, score: 0.94 },
      { wine: { _id: 'w2' }, score: 0.926666 },
      { wine: { _id: 'w3' }, score: 0.91 },
      { wine: { _id: 'w4' }, score: 0.9 },
      { wine: { _id: 'w5' }, score: 0.89 },
      { wine: { _id: 'w6' }, score: 0.88 }, // 6th qualifying — cut by top-5 cap
      { wine: { _id: 'w7' }, score: 0.84 }, // below soft-zone floor — filtered
    ];
    primeCandidates(ranked);

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(result.wine).toBeNull();
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.map((c) => c.wine._id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
    expect(result.candidates[1].score).toBe(0.93); // 0.926666 rounded
  });

  test('confirmCreate: true bypasses the soft zone and creates', async () => {
    primeCandidates([{ wine: EXISTING_WINE, score: 0.9 }]);

    const result = await findOrCreateWine(INPUT, USER_ID, { confirmCreate: true });

    expect(result.created).toBe(true);
    expect(result.wine._id).toBe('wine-new');
  });

  test('confirmCreate does NOT bypass the >= 0.95 auto-match', async () => {
    primeCandidates([{ wine: EXISTING_WINE, score: 0.95 }]);

    const result = await findOrCreateWine(INPUT, USER_ID, { confirmCreate: true });

    expect(result).toEqual({ wine: EXISTING_WINE, created: false });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('scorer is invoked with the trimmed query, candidates, and redistribute: false', async () => {
    const candidates = [EXISTING_WINE];
    primeCandidates([{ wine: EXISTING_WINE, score: 0.97 }]);

    await findOrCreateWine(
      { ...INPUT, name: ' Clos des Papes ', producer: ' Paul Avril ' },
      USER_ID
    );

    expect(scoreAllMatches).toHaveBeenCalledWith(
      { name: 'Clos des Papes', producer: 'Paul Avril', appellation: 'Châteauneuf-du-Pape' },
      candidates,
      { redistribute: false }
    );
  });

  test('Meilisearch failure falls back to MongoDB text search', async () => {
    searchService.getIsAvailable.mockReturnValue(true);
    searchService.search.mockRejectedValue(new Error('meili down'));
    WineDefinition.find.mockReturnValue(textSearchChain([EXISTING_WINE]));
    scoreAllMatches.mockReturnValue([{ wine: EXISTING_WINE, score: 0.97 }]);

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(WineDefinition.find).toHaveBeenCalledWith({
      $text: { $search: 'Clos des Papes Paul Avril' },
    });
    expect(result).toEqual({ wine: EXISTING_WINE, created: false });
  });
});

describe('findOrCreateWine — creation', () => {
  test('no match anywhere: creates the wine with resolved taxonomy ids and normalizedKey', async () => {
    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(WineDefinition).toHaveBeenCalledWith({
      name: 'Clos des Papes',
      producer: 'Paul Avril',
      country: 'country-1',
      region: 'region-1',
      appellation: 'Châteauneuf-du-Pape',
      type: 'red',
      grapes: ['grape-grenache', 'grape-syrah'],
      normalizedKey: INPUT_KEY,
      createdBy: USER_ID,
    });
    expect(result.created).toBe(true);
    expect(result.wine.save).toHaveBeenCalled();
    expect(result.wine.populate).toHaveBeenCalledWith(POPULATE);
    expect(searchService.indexWine).toHaveBeenCalledWith('wine-new');
  });

  test('unknown wine type defaults to "red"; valid types are kept', async () => {
    await findOrCreateWine({ ...INPUT, type: 'orange' }, USER_ID);
    expect(WineDefinition.mock.calls[0][0].type).toBe('red');

    jest.clearAllMocks();
    WineDefinition.findOne.mockReturnValue(findOneChain(null));
    searchService.getIsAvailable.mockReturnValue(false);
    WineDefinition.find.mockReturnValue(textSearchChain([]));
    Country.findOne.mockResolvedValue({ _id: 'country-1' });
    Region.findOne.mockResolvedValue({ _id: 'region-1' });
    Grape.findOne.mockResolvedValue({ _id: 'grape-1' });

    await findOrCreateWine({ ...INPUT, type: 'sparkling' }, USER_ID);
    expect(WineDefinition.mock.calls[0][0].type).toBe('sparkling');
  });

  test('field lengths are capped at 200 characters (registry pollution / fuzzy-cost bound)', async () => {
    await findOrCreateWine({ ...INPUT, name: 'x'.repeat(300) }, USER_ID);

    const doc = WineDefinition.mock.calls[0][0];
    expect(doc.name).toHaveLength(200);
    expect(doc.name).toBe('x'.repeat(200));
  });

  test('missing appellation and region are stored as null', async () => {
    Region.findOne.mockResolvedValue(null);
    Region.mockImplementation(function () {
      throw new Error('should not create a region without a name');
    });

    await findOrCreateWine({ ...INPUT, appellation: undefined, region: '' }, USER_ID);

    const doc = WineDefinition.mock.calls[0][0];
    expect(doc.appellation).toBeNull();
    expect(doc.region).toBeNull();
    expect(doc.normalizedKey).toBe(generateWineKey('Clos des Papes', 'Paul Avril', ''));
  });

  test('missing country rejects with a 400 error and creates nothing', async () => {
    await expect(findOrCreateWine({ ...INPUT, country: '' }, USER_ID)).rejects.toMatchObject({
      message: 'Country is required to create a wine',
      status: 400,
    });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('duplicate-key race (11000): returns the concurrently created wine as created: false', async () => {
    WineDefinition.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this._id = 'wine-new';
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      this.save = jest.fn().mockRejectedValue(err);
      this.populate = jest.fn().mockResolvedValue(this);
    });
    WineDefinition.findOne
      .mockReturnValueOnce(findOneChain(null)) // initial exact-match lookup
      .mockReturnValueOnce(findOneChain(EXISTING_WINE)); // retry after 11000

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(result).toEqual({ wine: EXISTING_WINE, created: false });
    expect(WineDefinition.findOne).toHaveBeenCalledTimes(2);
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  test('non-11000 save errors propagate', async () => {
    WineDefinition.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this.save = jest.fn().mockRejectedValue(new Error('validation failed'));
      this.populate = jest.fn().mockResolvedValue(this);
    });

    await expect(findOrCreateWine(INPUT, USER_ID)).rejects.toThrow('validation failed');
  });
});

describe('taxonomy find-or-create dedup', () => {
  test('findOrCreateCountry: existing country found by normalizedName, no create', async () => {
    const existing = { _id: 'country-1', name: 'France' };
    Country.findOne.mockResolvedValue(existing);

    const result = await findOrCreateCountry(' Fránce! ', USER_ID);

    expect(Country.findOne).toHaveBeenCalledWith({ normalizedName: 'france' });
    expect(result).toBe(existing);
    expect(Country).not.toHaveBeenCalled();
  });

  test('findOrCreateCountry: missing country is created with trimmed name + normalizedName', async () => {
    Country.findOne.mockResolvedValue(null);

    const result = await findOrCreateCountry(' New Zealand ', USER_ID);

    expect(Country).toHaveBeenCalledWith({
      name: 'New Zealand',
      normalizedName: 'new zealand',
      createdBy: USER_ID,
    });
    expect(result.save).toHaveBeenCalled();
  });

  test('findOrCreateCountry: blank name returns null without touching the DB', async () => {
    expect(await findOrCreateCountry('', USER_ID)).toBeNull();
    expect(await findOrCreateCountry('   ', USER_ID)).toBeNull();
    expect(Country.findOne).not.toHaveBeenCalled();
  });

  test('findOrCreateRegion: lookup is scoped to the country (same name, different country ≠ dup)', async () => {
    const existing = { _id: 'region-1' };
    Region.findOne.mockResolvedValue(existing);

    const result = await findOrCreateRegion('Rhône', 'country-1', USER_ID);

    expect(Region.findOne).toHaveBeenCalledWith({ country: 'country-1', normalizedName: 'rhone' });
    expect(result).toBe(existing);
    expect(Region).not.toHaveBeenCalled();
  });

  test('findOrCreateRegion: creates when missing; returns null without a countryId', async () => {
    Region.findOne.mockResolvedValue(null);

    const created = await findOrCreateRegion('Rhône', 'country-1', USER_ID);
    expect(Region).toHaveBeenCalledWith({
      name: 'Rhône',
      normalizedName: 'rhone',
      country: 'country-1',
      createdBy: USER_ID,
    });
    expect(created.save).toHaveBeenCalled();

    expect(await findOrCreateRegion('Rhône', null, USER_ID)).toBeNull();
    expect(await findOrCreateRegion('', 'country-1', USER_ID)).toBeNull();
  });

  test('findOrCreateGrapes: synonyms resolve to one canonical grape per call (Shiraz + Syrah → Syrah)', async () => {
    Grape.findOne.mockResolvedValue(null);

    const ids = await findOrCreateGrapes(['Shiraz', 'Syrah'], USER_ID);

    // "Shiraz" resolves to canonical "Syrah"; the second entry is an
    // intra-call duplicate and is skipped — one lookup, one create, one id.
    expect(Grape.findOne).toHaveBeenCalledTimes(1);
    expect(Grape.findOne).toHaveBeenCalledWith({
      $or: [{ normalizedName: 'syrah' }, { normalizedSynonyms: 'syrah' }],
    });
    expect(Grape).toHaveBeenCalledTimes(1);
    expect(Grape).toHaveBeenCalledWith({ name: 'Syrah', normalizedName: 'syrah', createdBy: USER_ID });
    expect(ids).toEqual(['grape-new']);
  });

  test('findOrCreateGrapes: existing grapes are reused, blanks skipped, non-array → []', async () => {
    const ids = await findOrCreateGrapes(['Grenache', '', '  ', 'Syrah'], USER_ID);

    expect(ids).toEqual(['grape-grenache', 'grape-syrah']);
    expect(Grape).not.toHaveBeenCalled(); // both existed

    expect(await findOrCreateGrapes(undefined, USER_ID)).toEqual([]);
    expect(await findOrCreateGrapes([], USER_ID)).toEqual([]);
  });

  test('findOrCreateGrapes: per-document synonym resolves to the canonical grape (no duplicate doc)', async () => {
    // The Tempranillo doc lists "Tinta Roriz" as a synonym; a wine created
    // with grape "Tinta Roriz" must reuse it, not create a new Grape.
    Grape.findOne.mockImplementation(async (q) => {
      const key = q.$or[0].normalizedName;
      if (key === 'tinta roriz') return { _id: 'grape-tempranillo' }; // matched via normalizedSynonyms
      return { _id: `grape-${key}` };
    });

    const ids = await findOrCreateGrapes(['Tinta Roriz'], USER_ID);

    expect(Grape.findOne).toHaveBeenCalledWith({
      $or: [{ normalizedName: 'tinta roriz' }, { normalizedSynonyms: 'tinta roriz' }],
    });
    expect(ids).toEqual(['grape-tempranillo']);
    expect(Grape).not.toHaveBeenCalled(); // no new doc
  });

  test('findOrCreateGrapes: two names resolving to the same doc yield one id', async () => {
    // e.g. "Tempranillo" (canonical) + "Tinta Roriz" (synonym) in the same
    // AI response — both resolve to the same document, id appears once.
    Grape.findOne.mockResolvedValue({ _id: 'grape-tempranillo' });

    const ids = await findOrCreateGrapes(['Tempranillo', 'Tinta Roriz'], USER_ID);

    expect(ids).toEqual(['grape-tempranillo']);
  });
});
