/**
 * The resolver and the label sweetness term (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * After the migration the plain "Riesling Spätlese" and the registry's
 * "Riesling Spätlese" that RECORDS trocken are name-identical: the sibling
 * prefix finds the recorded one, the fuzzy scorer rates them 1.0, and the
 * label-variant stage sees them as one label. No stage may link them without
 * a word to the member — the two may be two wines, and only the member knows.
 * An empty value is a wildcard for the migration and the merge queue, not for
 * an add: one-sided → the member is ASKED (the soft zone), also when search is
 * down and the sibling stage was the only one to see the row — dropped there,
 * the add used to create a twin. A caller that already confirmed the create
 * goes on to create; a match-only caller gets no match. Where both sides state
 * the same term the link is as silent as ever; where both state and differ it
 * is refused as before. Same mocks as findOrCreateWine.test.
 */
jest.mock('../models/WineDefinition', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  ctor.aggregate = jest.fn();
  return ctor;
});
jest.mock('../models/Country', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  ctor.exists = jest.fn();
  return ctor;
});
jest.mock('../models/Region', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  ctor.exists = jest.fn();
  return ctor;
});
jest.mock('../models/Grape', () => {
  const ctor = jest.fn();
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  return ctor;
});
jest.mock('../models/Appellation', () => ({ exists: jest.fn(), find: jest.fn(), findOne: jest.fn() }));
jest.mock('./search', () => ({ getIsAvailable: jest.fn(), search: jest.fn(), indexWine: jest.fn() }));
jest.mock('./wineMatching', () => ({ scoreAllMatches: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const searchService = require('./search');
const { scoreAllMatches } = require('./wineMatching');
const { findOrCreateWine } = require('./findOrCreateWine');

const USER_ID = 'user-1';
const QUERY = { name: 'Riesling Spätlese', producer: 'Weingut Keller', country: 'Germany', region: 'Rheinhessen', appellation: 'Rheinhessen', type: 'white', grapes: ['Riesling'] };
const TROCKEN = { name: 'trocken', band: 'dry', scale: 'still', regulated: true };
const HALBTROCKEN = { name: 'halbtrocken', band: 'off-dry', scale: 'still', regulated: true };
const recorded = (labelSweetness, over = {}) => ({ _id: 'wine-recorded', name: 'Riesling Spätlese', producer: 'Weingut Keller', country: { name: 'Germany' }, grapes: [], labelSweetness, ...over });

const findOneChain = (doc) => ({ populate: jest.fn().mockResolvedValue(doc) });
const taxonomyChain = (rows) => {
  const c = {};
  for (const m of ['select', 'sort', 'limit', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn().mockResolvedValue(rows);
  return c;
};
function primeFind({ canonicalHits = [], canonicalSiblings = [], siblings = [], meiliDocs = [], textDocs = [], producerRows = [] } = {}) {
  WineDefinition.find.mockImplementation((q) => {
    if (q && q.canonicalKey) {
      const docs = q.canonicalKey instanceof RegExp ? canonicalSiblings : canonicalHits;
      return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue(docs) }) };
    }
    if (q && q.normalizedKey) return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue(siblings) }) };
    if (q && q.producer && !q.canonicalKey && !q.normalizedKey) return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue(producerRows) }) };
    if (q && q.$text) return { populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(textDocs) }) };
    return { populate: jest.fn().mockResolvedValue(meiliDocs) };
  });
}
function primeCandidates(ranked) {
  const candidates = ranked.map((r) => r.wine);
  searchService.getIsAvailable.mockReturnValue(true);
  searchService.search.mockResolvedValue({ ids: candidates.map((c) => c._id) });
  primeFind({ meiliDocs: candidates });
  scoreAllMatches.mockReturnValue(ranked);
}

let warnSpy; let logSpy;
beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  Grape.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
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
  WineDefinition.findOne.mockReturnValue(findOneChain(null));
  WineDefinition.aggregate.mockResolvedValue([]);
  for (const Model of [Appellation, Region, Country, Grape]) Model.find.mockReturnValue(taxonomyChain([]));
  searchService.getIsAvailable.mockReturnValue(false);
  primeFind();
  scoreAllMatches.mockReturnValue([]);
  Country.findOne.mockResolvedValue({ _id: 'country-1' });
  Region.findOne.mockResolvedValue({ _id: 'region-1' });
  Country.exists.mockResolvedValue(null);
  Region.exists.mockResolvedValue(null);
  Appellation.exists.mockResolvedValue(null);
  Grape.findOne.mockImplementation(async (q) => ({ _id: `grape-${q.$or ? q.$or[0].normalizedName : q.normalizedName}` }));
});
afterEach(() => { warnSpy.mockRestore(); logSpy.mockRestore(); });

const asked = (result, wine) => {
  expect(result.wine).toBeNull();
  expect(result.created).toBeUndefined();
  expect(result.candidates).toEqual([{ wine, score: 1 }]);
};

describe('one side states a term, the other none — the member is asked, with search down', () => {
  test('a unique canonical sibling that RECORDS trocken: the plain Spätlese is not linked and not created — asked', async () => {
    const sibling = recorded(TROCKEN);
    primeFind({ canonicalSiblings: [sibling] });
    asked(await findOrCreateWine(QUERY, USER_ID), sibling);
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('a unique canonical-identity hit that records a term: asked', async () => {
    const hit = recorded(TROCKEN);
    primeFind({ canonicalHits: [hit] });
    asked(await findOrCreateWine(QUERY, USER_ID), hit);
  });

  test('a unique raw-key sibling that records a term: asked', async () => {
    const sibling = recorded(TROCKEN);
    primeFind({ siblings: [sibling] });
    asked(await findOrCreateWine(QUERY, USER_ID), sibling);
  });

  test('the member confirmed the create: the add goes on to create its own row', async () => {
    const sibling = recorded(TROCKEN);
    primeFind({ canonicalSiblings: [sibling] });
    const result = await findOrCreateWine(QUERY, USER_ID, { confirmCreate: true });
    expect(result.created).toBe(true);
    expect(result.wine).not.toBe(sibling);
  });

  test('a match-only caller is ASKED too — the draft publish, the admin create, resolve_wine and bulk_add all show their "similar" step from the candidates', async () => {
    const sibling = recorded(TROCKEN);
    primeFind({ canonicalSiblings: [sibling] });
    // The draft publish's exact probe (services/wineDraftOps.publishDraft).
    asked(await findOrCreateWine(QUERY, USER_ID, { matchOnly: true, allowPending: true, excludeId: 'draft-1', confirmCreate: false, skipSiblingMatch: false }), sibling);
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('a match-only caller that already confirmed the create gets no match, never the recorded twin', async () => {
    primeFind({ canonicalSiblings: [recorded(TROCKEN)] });
    expect(await findOrCreateWine(QUERY, USER_ID, { matchOnly: true, confirmCreate: true })).toEqual({ wine: null, noMatch: true });
  });

  test('the same row met by two stages is asked about once', async () => {
    const twin = recorded(TROCKEN);
    primeFind({ canonicalHits: [twin], canonicalSiblings: [twin] });
    const result = await findOrCreateWine(QUERY, USER_ID);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].wine).toBe(twin);
  });
});

describe('one-sided with search up', () => {
  test('a 1.0 fuzzy hit that records a term the add does not state falls to the soft zone', async () => {
    const candidate = recorded(TROCKEN);
    primeCandidates([{ wine: candidate, score: 1 }]);
    const result = await findOrCreateWine(QUERY, USER_ID);
    expect(result.wine).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].wine).toBe(candidate);
  });

  test('the other way round: the add states trocken in its name, the registry row records nothing — asked, not linked', async () => {
    const candidate = recorded(null);
    primeCandidates([{ wine: candidate, score: 0.97 }]);
    const result = await findOrCreateWine({ ...QUERY, name: 'Riesling Spätlese trocken' }, USER_ID);
    expect(result.wine).toBeNull();
    expect(result.candidates[0].wine).toBe(candidate);
  });
});

describe('the label-variant stage, the last link before a create', () => {
  // The sibling is in the producer-scoped pool the stage scans; the earlier
  // stages see nothing, so this stage is the only one that meets the row.
  test('a confirmed create does not link to a same-producer row that records a term the add does not state', async () => {
    const sibling = recorded(TROCKEN);
    primeFind({ producerRows: [sibling] });
    const result = await findOrCreateWine(QUERY, USER_ID, { confirmCreate: true });
    expect(result.created).toBe(true);
    expect(result.labelVariantOf).toBeUndefined();
    expect(result.wine).not.toBe(sibling);
  });

  test('…and still links the same label when neither side states a sweetness', async () => {
    const sibling = recorded(null);
    primeFind({ producerRows: [sibling] });
    const result = await findOrCreateWine(QUERY, USER_ID, { confirmCreate: true });
    expect(result).toMatchObject({ wine: sibling, created: false, labelVariantOf: sibling.name });
  });
});

describe('both sides state', () => {
  test('the same term, recorded on the row and stated in the add\'s name: a unique sibling links as silently as ever', async () => {
    const sibling = recorded(TROCKEN);
    primeFind({ canonicalSiblings: [sibling] });
    const result = await findOrCreateWine({ ...QUERY, name: 'Riesling Spätlese trocken' }, USER_ID);
    expect(result).toEqual({ wine: sibling, created: false });
  });

  test('different terms: the recorded halbtrocken is refused for an add that states trocken, even at 1.0', async () => {
    const candidate = recorded(HALBTROCKEN);
    primeCandidates([{ wine: candidate, score: 1 }]);
    const result = await findOrCreateWine({ ...QUERY, name: 'Riesling Spätlese trocken' }, USER_ID);
    expect(result.wine).toBeNull();
    expect(result.candidates[0].wine).toBe(candidate);
  });

  test('neither side states anything: a unique sibling still links (nothing changed for the ordinary wine)', async () => {
    const sibling = recorded(null);
    primeFind({ canonicalSiblings: [sibling] });
    expect(await findOrCreateWine(QUERY, USER_ID)).toEqual({ wine: sibling, created: false });
  });
});
