/**
 * Guards the registry-pollution defenses of findOrCreateWine — this code path
 * previously auto-created ~430 junk registry entries, so the threshold routing
 * IS the feature:
 *
 *   producer-prefix strip (step 0)     → "Amisfield Pinot Noir"/"Amisfield" is
 *                                        canonicalized to "Pinot Noir" before ANY matching
 *   exact normalizedKey match          → return existing, never create
 *   unique producer+name sibling (1b)  → auto-match regardless of appellation
 *                                        (unless skipSiblingMatch)
 *   fuzzy score >= 0.95                → auto-match existing (>= — exactly 0.95 matches)
 *   0.85 <= score < 0.95 (soft zone)   → { wine: null, candidates } "did you mean?",
 *                                        never a silent create (unless confirmCreate)
 *   score < 0.85                       → create a new registry entry
 *
 * The scorer (wineMatching.scoreAllMatches) is mocked so the boundary values
 * can be pinned exactly; wineMatching has its own dedicated suites. The
 * normalize utils (generateWineKey, normalizeString, resolveGrapeName) and the
 * producer-prefix stripper are the REAL implementations, so key generation,
 * grape-synonym dedup and prefix stripping are tested for real.
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
  ctor.exists = jest.fn();
  return ctor;
});
jest.mock('../models/Region', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.exists = jest.fn();
  return ctor;
});
jest.mock('../models/Grape', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../models/Appellation', () => ({ exists: jest.fn() }));
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
const Appellation = require('../models/Appellation');
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

/**
 * Query-shape dispatcher for WineDefinition.find — the service issues five
 * differently-chained find() queries, so a single mockReturnValue can't serve
 * them all:
 *   { canonicalKey: string } → .limit(2).populate(...)   (step 1a canonical identity)
 *   { canonicalKey: RegExp } → .limit(2).populate(...)   (step 1b canonical sibling)
 *   { normalizedKey: RegExp } → .limit(2).populate(...)  (step 1b raw-sibling fallback)
 *   { _id: { $in: ids } }     → .populate(...)           (Meilisearch id fetch)
 *   { $text: ... }            → .populate(...).limit(20) (Mongo text fallback)
 */
function primeFind({ canonicalHits = [], canonicalSiblings = [], siblings = [], meiliDocs = [], textDocs = [] } = {}) {
  WineDefinition.find.mockImplementation((q) => {
    if (q && q.canonicalKey) {
      const docs = q.canonicalKey instanceof RegExp ? canonicalSiblings : canonicalHits;
      return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue(docs) }) };
    }
    if (q && q.normalizedKey) {
      return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue(siblings) }) };
    }
    if (q && q.$text) {
      return { populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(textDocs) }) };
    }
    return { populate: jest.fn().mockResolvedValue(meiliDocs) };
  });
}

/** Prime the Meilisearch path with ranked results the mocked scorer returns. */
function primeCandidates(ranked) {
  const candidates = ranked.map((r) => r.wine);
  searchService.getIsAvailable.mockReturnValue(true);
  searchService.search.mockResolvedValue({ ids: candidates.map((c) => c._id) });
  primeFind({ meiliDocs: candidates });
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

  // Defaults: no exact match, no siblings, Meilisearch down, text fallback
  // empty → create path
  WineDefinition.findOne.mockReturnValue(findOneChain(null));
  searchService.getIsAvailable.mockReturnValue(false);
  primeFind();
  scoreAllMatches.mockReturnValue([]);

  // Taxonomy defaults: everything already exists
  Country.findOne.mockResolvedValue({ _id: 'country-1' });
  Region.findOne.mockResolvedValue({ _id: 'region-1' });
  // Producer-place gate defaults: the producer is NOT a known place
  Country.exists.mockResolvedValue(null);
  Region.exists.mockResolvedValue(null);
  Appellation.exists.mockResolvedValue(null);
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

describe('findOrCreateWine — producer-prefix canonicalization (step 0)', () => {
  // Registry canon: the name never embeds the producer. Cellar-format imports
  // and non-compliant AI output arrive as "Producer Wine Name" + "Producer" —
  // these previously minted producer-in-name duplicates (42 on prod, 2026-07-11).
  const PREFIXED = { ...INPUT, name: 'Paul Avril Clos des Papes' };

  test('name embedding the producer is stripped before the exact-key lookup', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(EXISTING_WINE));

    const result = await findOrCreateWine(PREFIXED, USER_ID);

    // INPUT_KEY is built from the producer-free name — the prefixed input must
    // resolve to the very same key.
    expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: INPUT_KEY });
    expect(result).toEqual({ wine: EXISTING_WINE, created: false });
  });

  test('created wines store the stripped name, never producer-in-name', async () => {
    const result = await findOrCreateWine(PREFIXED, USER_ID);

    expect(result.created).toBe(true);
    expect(WineDefinition.mock.calls[0][0].name).toBe('Clos des Papes');
    expect(WineDefinition.mock.calls[0][0].normalizedKey).toBe(INPUT_KEY);
  });

  test('a doubled producer prefix is stripped repeatedly', async () => {
    await findOrCreateWine({ ...INPUT, name: 'Paul Avril Paul Avril Clos des Papes' }, USER_ID);

    expect(WineDefinition.mock.calls[0][0].name).toBe('Clos des Papes');
  });

  test('a name identical to the producer is left alone (nothing would remain)', async () => {
    await findOrCreateWine({ ...INPUT, name: 'Paul Avril' }, USER_ID);

    expect(WineDefinition.mock.calls[0][0].name).toBe('Paul Avril');
  });
});

describe('findOrCreateWine — producer-VARIANT key-prefix canonicalization (step 0, dup analysis 2026-07-22)', () => {
  // The exact-string strip is blind when the producer field is a variant:
  // name "Felton Road Block 3 Pinot Noir" + producer "Felton Road Wines Ltd"
  // never matched, minted a duplicate, and scored just 0.62 against the real
  // record — the shape behind most July-2026 prod duplicates. The key-token
  // prefix strip closes it.
  test('variant producer key prefix is stripped before the exact-key lookup', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(EXISTING_WINE));

    const result = await findOrCreateWine(
      { ...INPUT, name: 'Felton Road Block 3 Pinot Noir', producer: 'Felton Road Wines Ltd', appellation: 'Bannockburn' },
      USER_ID
    );

    expect(WineDefinition.findOne).toHaveBeenCalledWith({
      normalizedKey: generateWineKey('Block 3 Pinot Noir', 'Felton Road Wines Ltd', 'Bannockburn'),
    });
    expect(result).toEqual({ wine: EXISTING_WINE, created: false });
  });

  test('created wines store the key-stripped name', async () => {
    const result = await findOrCreateWine(
      { ...INPUT, name: 'Maude Kids Block Pinot Noir', producer: 'Maude Wines' },
      USER_ID
    );

    expect(result.created).toBe(true);
    expect(WineDefinition.mock.calls[0][0].name).toBe('Kids Block Pinot Noir');
  });

  test('a name ENDING with the producer key is left alone — "Les Forts de Latour" is a real wine name', async () => {
    await findOrCreateWine(
      { ...INPUT, name: 'Les Forts de Latour', producer: 'Château Latour', appellation: 'Pauillac' },
      USER_ID
    );

    expect(WineDefinition.mock.calls[0][0].name).toBe('Les Forts de Latour');
  });
});

describe('findOrCreateWine — different-country guard', () => {
  // Identical canonical producer+name can still be two wineries (Domaine
  // Chandon, Napa vs Bodegas Chandon, Mendoza — the Garden Spritz false
  // positive). A stated-and-conflicting country must block every silent link.
  const QUERY = {
    name: 'Garden Spritz',
    producer: 'Chandon',
    country: 'United States',
    region: '',
    appellation: 'Napa Valley',
    type: 'sparkling',
    grapes: ['Chardonnay'],
  };

  test('a single sibling with a conflicting country is NOT auto-linked (falls through to create)', async () => {
    const sibling = { _id: 'wine-ar', name: 'Garden Spritz', country: { name: 'Argentina' } };
    primeFind({ siblings: [sibling] });

    const result = await findOrCreateWine(QUERY, USER_ID);

    expect(result.created).toBe(true);
    expect(result.wine).not.toBe(sibling);
  });

  test('a single sibling with the SAME country still auto-links — aliases resolve ("USA" = "United States")', async () => {
    const sibling = { _id: 'wine-us', name: 'Garden Spritz', country: { name: 'United States' } };
    primeFind({ siblings: [sibling] });

    const result = await findOrCreateWine({ ...QUERY, country: 'USA' }, USER_ID);

    expect(result).toEqual({ wine: sibling, created: false });
  });

  test('a >=0.95 fuzzy hit with a conflicting country falls to the soft zone instead of auto-linking', async () => {
    const candidate = { _id: 'wine-ar', name: 'Garden Spritz', country: { name: 'Argentina' } };
    primeCandidates([{ wine: candidate, score: 0.96 }]);

    const result = await findOrCreateWine(QUERY, USER_ID);

    expect(result.wine).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].wine).toBe(candidate);
  });

  test('auto-match skips a conflicting-country candidate but takes the next confident one', async () => {
    const wrongCountry = { _id: 'wine-ar', name: 'Garden Spritz', country: { name: 'Argentina' } };
    const rightCountry = { _id: 'wine-us', name: 'Garden Spritz', country: { name: 'United States' } };
    primeCandidates([{ wine: wrongCountry, score: 0.97 }, { wine: rightCountry, score: 0.96 }]);

    const result = await findOrCreateWine(QUERY, USER_ID);

    expect(result).toEqual({ wine: rightCountry, created: false });
  });

  test('with confirmCreate, a conflicting-country near-match creates the new wine', async () => {
    const candidate = { _id: 'wine-ar', name: 'Garden Spritz', country: { name: 'Argentina' } };
    primeCandidates([{ wine: candidate, score: 0.96 }]);

    const result = await findOrCreateWine(QUERY, USER_ID, { confirmCreate: true });

    expect(result.created).toBe(true);
  });
});

describe('findOrCreateWine — nearMiss reporting on confirmed create', () => {
  // confirmCreate callers (cellar import) skip the soft-zone prompt by design.
  // When creation proceeds PAST a >=0.85 candidate, the caller needs to know —
  // that shape is exactly what used to mint silent duplicates, and the import
  // path audit-logs it for admin review.
  test('creating past a soft-zone candidate reports it as nearMiss', async () => {
    const near = { _id: 'wine-near', name: 'Clos des Papes', producer: 'Paul Avril' };
    primeCandidates([{ wine: near, score: 0.9 }]);

    const result = await findOrCreateWine(INPUT, USER_ID, { confirmCreate: true });

    expect(result.created).toBe(true);
    expect(result.nearMiss).toEqual({
      wineId: 'wine-near',
      name: 'Clos des Papes',
      producer: 'Paul Avril',
      score: 0.9,
    });
  });

  test('a clean create (no soft-zone candidate) reports no nearMiss', async () => {
    primeCandidates([{ wine: { _id: 'wine-far', name: 'Other' }, score: 0.4 }]);

    const result = await findOrCreateWine(INPUT, USER_ID, { confirmCreate: true });

    expect(result.created).toBe(true);
    expect(result.nearMiss).toBeUndefined();
  });
});

describe('findOrCreateWine — canonical-identity match (step 1a)', () => {
  // The lookup-first design from the 2026-07-22 dup analysis: any spelling of
  // an already-registered wine resolves to it BEFORE fuzzy scoring, so a
  // canonical duplicate cannot be minted.
  const CANONICAL_HIT = { _id: 'wine-canon', name: 'Block 3 Pinot Noir', producer: 'Felton Road' };

  test('a single canonical hit returns the existing wine — variant input, no fuzzy, no create', async () => {
    primeFind({ canonicalHits: [CANONICAL_HIT] });

    const result = await findOrCreateWine(
      { ...INPUT, name: 'Felton Road Block 3 Pinot Noir', producer: 'Felton Road Wines Ltd', appellation: 'Bannockburn' },
      USER_ID
    );

    expect(result).toEqual({ wine: CANONICAL_HIT, created: false });
    expect(scoreAllMatches).not.toHaveBeenCalled();
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('two canonical hits (a pre-existing duplicate cluster) fall through — never picks one arbitrarily', async () => {
    primeFind({ canonicalHits: [{ _id: 'dup-a' }, { _id: 'dup-b' }] });

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(result.created).toBe(true); // empty fuzzy → creates; the cluster stays for the admin queue
  });

  test('a canonical hit with a conflicting country is not linked', async () => {
    primeFind({ canonicalHits: [{ _id: 'wine-ar', name: 'Garden Spritz', country: { name: 'Argentina' } }] });

    const result = await findOrCreateWine(
      { name: 'Garden Spritz', producer: 'Chandon', country: 'United States', region: '', appellation: '', type: 'sparkling', grapes: ['Chardonnay'] },
      USER_ID
    );

    expect(result.created).toBe(true);
  });

  test('canonical SIBLING (same identity, other appellation) matches when unique', async () => {
    primeFind({ canonicalSiblings: [CANONICAL_HIT] });

    const result = await findOrCreateWine(
      { ...INPUT, name: 'Felton Road Block 3 Pinot Noir', producer: 'Felton Road Wines Ltd', appellation: 'Central Otago' },
      USER_ID
    );

    expect(result).toEqual({ wine: CANONICAL_HIT, created: false });
  });
});

describe('findOrCreateWine — sibling match (step 1b)', () => {
  // Same producer + same canonical name but a different appellation granularity
  // ("Cromwell" vs "Central Otago") misses the exact key and fuzzy-scores ~0.90
  // — below auto-match — so non-interactive callers used to create a duplicate.
  const SIBLING = {
    _id: 'wine-sibling',
    name: 'Clos des Papes',
    producer: 'Paul Avril',
    appellation: 'Rhône',
  };

  test('a unique producer+name hit auto-matches regardless of appellation — no create, no fuzzy', async () => {
    primeFind({ siblings: [SIBLING] });

    const result = await findOrCreateWine(INPUT, USER_ID);

    expect(result).toEqual({ wine: SIBLING, created: false });
    expect(scoreAllMatches).not.toHaveBeenCalled();
    expect(WineDefinition).not.toHaveBeenCalled();
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  test('sibling match fires under confirmCreate too (non-interactive importers rely on it)', async () => {
    primeFind({ siblings: [SIBLING] });

    const result = await findOrCreateWine(INPUT, USER_ID, { confirmCreate: true });

    expect(result).toEqual({ wine: SIBLING, created: false });
  });

  test('the sibling lookup uses an anchored producer:name: prefix regex', async () => {
    primeFind({ siblings: [SIBLING] });

    await findOrCreateWine(INPUT, USER_ID);

    const call = WineDefinition.find.mock.calls.find((c) => c[0] && c[0].normalizedKey);
    const regex = call[0].normalizedKey;
    expect(regex).toBeInstanceOf(RegExp);
    expect(regex.source.startsWith('^')).toBe(true);
    expect('paul avril:clos des papes:any appellation at all').toMatch(regex);
    expect('other producer:clos des papes:').not.toMatch(regex);
  });

  test('several siblings fall through to the fuzzy scorer instead of picking one arbitrarily', async () => {
    primeFind({ siblings: [SIBLING, { _id: 'wine-sibling-2' }] });

    const result = await findOrCreateWine(INPUT, USER_ID);

    // Default fuzzy mocks are empty → the create path proves we fell through.
    expect(result.created).toBe(true);
  });

  test('skipSiblingMatch honours an explicit "create anyway" over a lone sibling', async () => {
    primeFind({ siblings: [SIBLING] });

    const result = await findOrCreateWine(INPUT, USER_ID, { confirmCreate: true, skipSiblingMatch: true });

    expect(result.created).toBe(true);
    expect(result.wine._id).toBe('wine-new');
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
    primeFind({ textDocs: [EXISTING_WINE] });
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
      createdVia: null, // provenance default — 'mcp' only via the MCP write tools
    });
    expect(result.created).toBe(true);
    expect(result.wine.save).toHaveBeenCalled();
    expect(result.wine.populate).toHaveBeenCalledWith(POPULATE);
    expect(searchService.indexWine).toHaveBeenCalledWith('wine-new');
  });

  test('matchOnly: no match anywhere returns { noMatch: true } and creates NOTHING (registry-safe demo clone)', async () => {
    const result = await findOrCreateWine(INPUT, USER_ID, { confirmCreate: true, matchOnly: true });

    expect(result.wine).toBeNull();
    expect(result.noMatch).toBe(true);
    // The load-bearing guarantee: a match-only resolve never mints a
    // WineDefinition, taxonomy, or search index entry on a miss.
    expect(WineDefinition).not.toHaveBeenCalled(); // no `new WineDefinition(...)`
    expect(Country.findOne).not.toHaveBeenCalled();
    expect(Region.findOne).not.toHaveBeenCalled();
    expect(Grape.findOne).not.toHaveBeenCalled();
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  test('matchOnly still resolves an EXACT existing match (created: false), never creating', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(EXISTING_WINE));
    const result = await findOrCreateWine(INPUT, USER_ID, { matchOnly: true });
    expect(result.wine).toBe(EXISTING_WINE);
    expect(result.created).toBe(false);
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('unknown wine type defaults to "red"; valid types are kept', async () => {
    await findOrCreateWine({ ...INPUT, type: 'orange' }, USER_ID);
    expect(WineDefinition.mock.calls[0][0].type).toBe('red');

    jest.clearAllMocks();
    WineDefinition.findOne.mockReturnValue(findOneChain(null));
    searchService.getIsAvailable.mockReturnValue(false);
    primeFind();
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

  test('producer-place gate: a producer that IS a known place is rejected 400 at mint (audit RC-2)', async () => {
    Region.exists.mockResolvedValue({ _id: 'region-bordeaux' });

    await expect(findOrCreateWine({ ...INPUT, producer: 'Bordeaux' }, USER_ID)).rejects.toMatchObject({
      message: expect.stringContaining('wine region, not a producer'),
      status: 400,
    });
    expect(WineDefinition).not.toHaveBeenCalled();
    // The gate consults all three taxonomies with the normalized producer.
    expect(Region.exists).toHaveBeenCalledWith({
      $or: [{ normalizedName: 'bordeaux' }, { normalizedSynonyms: 'bordeaux' }],
    });
    expect(Appellation.exists).toHaveBeenCalledWith({ normalizedName: 'bordeaux' });
  });

  test('producer-place gate: exact full-string match only — "Marchesi di Barolo" passes', async () => {
    // The taxonomy holds "barolo"; the gate must query the FULL normalized
    // producer, which no taxonomy row equals — mocks return null (default).
    await findOrCreateWine({ ...INPUT, producer: 'Marchesi di Barolo' }, USER_ID);

    expect(Appellation.exists).toHaveBeenCalledWith({ normalizedName: 'marchesi di barolo' });
    expect(WineDefinition).toHaveBeenCalled(); // created normally
  });

  test('producer-place gate runs at MINT only — the exact-match path never queries it', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(EXISTING_WINE));

    await findOrCreateWine({ ...INPUT, producer: 'Bordeaux' }, USER_ID);

    expect(Country.exists).not.toHaveBeenCalled();
    expect(Region.exists).not.toHaveBeenCalled();
    expect(Appellation.exists).not.toHaveBeenCalled();
  });

  test('a single-character producer is rejected at mint ("G" — audit RC-5)', async () => {
    await expect(findOrCreateWine({ ...INPUT, producer: 'G' }, USER_ID)).rejects.toMatchObject({
      message: expect.stringContaining('not a usable producer name'),
      status: 400,
    });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('step 0 strips a trailing vintage year before matching (registry is vintage-neutral)', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(EXISTING_WINE));

    await findOrCreateWine({ ...INPUT, name: 'Clos des Papes 2019' }, USER_ID);

    // The year never reaches the dedup key — same key as the year-free name.
    expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: INPUT_KEY });
  });

  test('a leading-year brand name survives step 0 ("1924 Double Black")', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(null));

    await findOrCreateWine({ ...INPUT, name: '1924 Double Black' }, USER_ID);

    const doc = WineDefinition.mock.calls[0][0];
    expect(doc.name).toBe('1924 Double Black');
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

  test('findOrCreateCountry: an unrecognized string is rejected with 400 and mints NOTHING (the "Espalda" gate)', async () => {
    Country.findOne.mockResolvedValue(null);

    await expect(findOrCreateCountry('Espalda', USER_ID)).rejects.toMatchObject({
      message: expect.stringContaining('Unrecognized country "Espalda"'),
      status: 400,
    });
    expect(Country).not.toHaveBeenCalled(); // no `new Country(...)`
  });

  test('findOrCreateCountry: an EXISTING doc always passes, recognized or not (gate guards the mint only)', async () => {
    // Prod still carries pre-gate junk ("Espalda") until the cleanup deletes
    // it — matching an existing doc is not minting, so adds keep working while
    // the taxonomy is repaired.
    const existing = { _id: 'country-junk', name: 'Espalda' };
    Country.findOne.mockResolvedValue(existing);

    expect(await findOrCreateCountry('Espalda', USER_ID)).toBe(existing);
    expect(Country).not.toHaveBeenCalled();
  });

  test('findOrCreateCountry: a real country absent from the taxonomy still mints (India)', async () => {
    Country.findOne.mockResolvedValue(null);

    const result = await findOrCreateCountry('India', USER_ID);

    expect(Country).toHaveBeenCalledWith({
      name: 'India',
      normalizedName: 'india',
      createdBy: USER_ID,
    });
    expect(result.save).toHaveBeenCalled();
  });

  test('findOrCreateCountry: an aliased local name resolves, passes the gate, and mints the CANONICAL name', async () => {
    Country.findOne.mockResolvedValue(null);

    await findOrCreateCountry('Moldavien', USER_ID); // sv → Moldova

    expect(Country.findOne).toHaveBeenCalledWith({ normalizedName: 'moldova' });
    expect(Country).toHaveBeenCalledWith({
      name: 'Moldova',
      normalizedName: 'moldova',
      createdBy: USER_ID,
    });
  });

  test('findOrCreateRegion: lookup is scoped to the country (same name, different country ≠ dup) and matches synonyms', async () => {
    const existing = { _id: 'region-1' };
    Region.findOne.mockResolvedValue(existing);

    const result = await findOrCreateRegion('Rhône', 'country-1', USER_ID);

    expect(Region.findOne).toHaveBeenCalledWith({
      country: 'country-1',
      $or: [{ normalizedName: 'rhone' }, { normalizedSynonyms: 'rhone' }],
    });
    expect(result).toBe(existing);
    expect(Region).not.toHaveBeenCalled();
  });

  test('findOrCreateRegion: a comma-packed hierarchy is never minted — null region instead (audit RC-8)', async () => {
    Region.findOne.mockResolvedValue(null);

    expect(await findOrCreateRegion('Bordeaux, Haut-Médoc', 'country-1', USER_ID)).toBeNull();
    expect(await findOrCreateRegion('Niagara Peninsula, Ontario', 'country-1', USER_ID)).toBeNull();
    expect(Region).not.toHaveBeenCalled(); // no `new Region(...)`
  });

  test('findOrCreateRegion: a region named like a COUNTRY is never minted ("Scotland" under England)', async () => {
    Region.findOne.mockResolvedValue(null);

    expect(await findOrCreateRegion('Scotland', 'country-england', USER_ID)).toBeNull();
    expect(Region).not.toHaveBeenCalled();
  });

  test('findOrCreateRegion: an EXISTING doc still matches even when named like a country (matching ≠ minting)', async () => {
    const existing = { _id: 'region-georgia-usa', name: 'Georgia' };
    Region.findOne.mockResolvedValue(existing);

    expect(await findOrCreateRegion('Georgia', 'country-usa', USER_ID)).toBe(existing);
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

  test('findOrCreateGrapes: blend percentages are stripped, bare percentages dropped', async () => {
    Grape.findOne.mockResolvedValue({ _id: 'grape-mourvedre' });

    // "70% Monastrell" → strip % → synonym-resolve → Mourvèdre; "30%" → dropped
    const ids = await findOrCreateGrapes(['70% Monastrell', '30%'], USER_ID);

    expect(Grape.findOne).toHaveBeenCalledTimes(1);
    expect(Grape.findOne).toHaveBeenCalledWith({
      $or: [{ normalizedName: 'mourvedre' }, { normalizedSynonyms: 'mourvedre' }],
    });
    expect(ids).toEqual(['grape-mourvedre']);
    expect(Grape).not.toHaveBeenCalled(); // no junk doc created
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
