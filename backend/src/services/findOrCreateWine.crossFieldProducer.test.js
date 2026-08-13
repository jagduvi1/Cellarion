/**
 * The MINT-TIME cross-field producer gate.
 *
 * THE INCIDENT (prod 2026-08-13): a label scan returned producer "Pays d'Oc
 * Organic Wine" / name "Chardonnay Reserve". Wrong — but both boxes were
 * filled, so nothing on the way to the registry had anything to complain
 * about, and the row minted as an ordinary, published, searchable wine. Every
 * gate on this path asked whether the producer was MISSING; none asked whether
 * the string was a producer.
 *
 * The six IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS rules ask exactly that, and
 * the curation queue has refused writes on them since v1.106.0. This suite
 * pins them at the OTHER end of the same pipe — the mint chokepoint — with the
 * same two outcomes every gate in findOrCreateWine has:
 *
 *   allowPending (commit paths)  → pendingIdentity, producer never stored, the
 *                                  user's bottle saves. Never harder to add.
 *   no allowPending (curation)   → a 400, like the place gate beside it.
 *
 * …and it pins the two boundaries that keep the gate cheap and safe: it runs
 * on CREATES ONLY (every resolve stage returns above it), and a clean producer
 * is untouched.
 *
 * Same mocking strategy as findOrCreateWine.pendingIdentity.test.js — real
 * normalize utils and REAL cross-field rules, evaluated against a mocked
 * taxonomy, so the rule bodies are exercised rather than stubbed.
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
jest.mock('../models/Appellation', () => ({ exists: jest.fn(), find: jest.fn() }));
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
const { findOrCreateWine } = require('./findOrCreateWine');

const USER = '507f1f77bcf86cd799439011';

const BASE = {
  name: 'Chardonnay Reserve',
  producer: 'Cave de Kaysersberg',
  country: 'France',
  region: '',
  appellation: '',
  type: 'white',
  grapes: [],
};

/** A .select()/.sort()/.limit()-chainable lean query returning `rows`. */
const chain = (rows) => {
  const c = {};
  for (const m of ['select', 'sort', 'limit', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn().mockResolvedValue(rows);
  return c;
};

const findOneChain = (doc) => ({ populate: jest.fn().mockResolvedValue(doc) });

/** The document the mocked constructor was called with on a create. */
const minted = () => WineDefinition.mock.calls[0][0];

/**
 * The taxonomy the cross-field rules are evaluated against. Deliberately small
 * and named after the rules that read it — every doc here exists to make ONE
 * rule fire.
 */
const TAXONOMY = {
  appellations: [
    // The SYNONYM is the point: the mint-time place gate queries Appellation by
    // normalizedName only, so a synonym spelling reaches this rule and nothing
    // else.
    { _id: 'a1', name: 'Monbazillac', normalizedName: 'monbazillac', normalizedSynonyms: ['monbaziyac'] },
  ],
  regions: [{ _id: 'r1', name: 'Dragasani', normalizedName: 'dragasani', normalizedSynonyms: [] }],
  // Country docs are deliberately EMPTY: the country rule also probes the
  // static recognized-country list, which is how "India" flags before anybody
  // has minted a Country doc for it.
  countries: [],
  grapes: [{ _id: 'g1', name: 'Syrah', normalizedName: 'syrah', normalizedSynonyms: ['shiraz'] }],
};

let warnSpy;

beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
  WineDefinition.find.mockImplementation((q) => {
    if (q && q.$text) return { populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) };
    return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue([]) }) };
  });

  // Appellation.find serves TWO readers: the canonical-spelling resolver
  // (queries with $or, must find nothing so the typed string is kept verbatim)
  // and the cross-field reference load (queries {} for the whole list).
  Appellation.find.mockImplementation((q) => chain(q && q.$or ? [] : TAXONOMY.appellations));
  Region.find.mockReturnValue(chain(TAXONOMY.regions));
  Country.find.mockReturnValue(chain(TAXONOMY.countries));
  Grape.find.mockReturnValue(chain(TAXONOMY.grapes));

  searchService.getIsAvailable.mockReturnValue(false);
  scoreAllMatches.mockReturnValue([]);

  Country.findOne.mockResolvedValue({ _id: 'country-1' });
  Region.findOne.mockResolvedValue({ _id: 'region-1' });
  // The place gate finds NOTHING — every pending outcome below is this rule
  // family's doing, not the older gate's.
  Country.exists.mockResolvedValue(null);
  Region.exists.mockResolvedValue(null);
  Appellation.exists.mockResolvedValue(null);
  Grape.findOne.mockResolvedValue({ _id: 'grape-1' });
});

afterEach(() => warnSpy.mockRestore());

// ── The six rules, one mint each ─────────────────────────────────────────────

describe('a producer that is not a producer mints PENDING on the commit paths', () => {
  test.each([
    // [label, producer, expected rule id]
    ['an appellation SYNONYM the place gate cannot see', 'Monbaziyac', 'producer-is-appellation.v1'],
    ['a region', 'Dragasani', 'producer-is-region.v1'],
    ['a country with no Country doc yet', 'India', 'producer-is-country.v1'],
    ['a grape', 'Syrah', 'producer-is-grape.v1'],
    ['a grape SYNONYM', 'Shiraz', 'producer-is-grape.v1'],
    ['a style descriptor', 'Roșu Demidulce', 'producer-is-style-term.v2'],
    ['a placeholder phrase', 'Winery Unknown', 'producer-placeholder.v1'],
  ])('%s → pendingIdentity, producer never stored', async (_label, producer, ruleId) => {
    const res = await findOrCreateWine({ ...BASE, producer }, USER, { allowPending: true });

    expect(res.created).toBe(true);
    expect(res.pendingIdentity).toBe(true);
    expect(minted().pendingIdentity).toBe(true);
    expect(minted().producer).toBe('');
    // The rejected string survives for the caller's audit entry — the row has
    // no field for it and the queue would otherwise show one fewer clue than
    // the user had on screen.
    expect(res.producerRejected).toEqual({
      producer, check: ruleId, detail: expect.any(String),
    });
  });

  test('the bottle still saves — nothing is ever thrown on a commit path', async () => {
    await expect(findOrCreateWine({ ...BASE, producer: 'Syrah' }, USER, { allowPending: true }))
      .resolves.toMatchObject({ created: true });
  });

  test('a real producer is untouched: no flag, no pending key, no rejection record', async () => {
    const res = await findOrCreateWine(BASE, USER, { allowPending: true });

    expect(res.pendingIdentity).toBeUndefined();
    expect(res.producerRejected).toBeUndefined();
    expect(minted().pendingIdentity).toBe(false);
    expect(minted().producer).toBe('Cave de Kaysersberg');
  });

  // producer-echoes-name.v1 is deliberately NOT in the blocking set: refusing
  // producer == name is how an earlier revision condemned Château Margaux,
  // Petrus, Krug and 64 other real single-wine estates.
  test('a single-wine estate (producer == name) still mints public', async () => {
    const res = await findOrCreateWine(
      { ...BASE, name: 'Château Margaux', producer: 'Château Margaux' }, USER, { allowPending: true }
    );

    expect(res.pendingIdentity).toBeUndefined();
    expect(minted().producer).toBe('Château Margaux');
  });

  // name-in-producer / producer-parenthetical flag rows that are REAL but badly
  // formatted; those stay review-only, exactly as on the curation queue.
  test('a merely badly-FORMATTED producer is not blocked', async () => {
    const res = await findOrCreateWine(
      { ...BASE, producer: "Trader Joe's (Bersano Estate)" }, USER, { allowPending: true }
    );

    expect(res.pendingIdentity).toBeUndefined();
    expect(minted().producer).toBe("Trader Joe's (Bersano Estate)");
  });
});

// ── The curation surfaces keep being told ────────────────────────────────────

describe('WITHOUT allowPending the gate throws a 400, like the place gate beside it', () => {
  test.each([
    ['Monbaziyac', 'producer-is-appellation.v1'],
    ['Dragasani', 'producer-is-region.v1'],
    ['India', 'producer-is-country.v1'],
    ['Syrah', 'producer-is-grape.v1'],
    ['Roșu Demidulce', 'producer-is-style-term.v2'],
    ['Winery Unknown', 'producer-placeholder.v1'],
  ])('"%s" is refused, and the message names the rule', async (producer, ruleId) => {
    await expect(findOrCreateWine({ ...BASE, producer }, USER))
      .rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining(ruleId),
      });
    // Nothing was created — the refusal is a refusal, not a silent pending row.
    expect(WineDefinition).not.toHaveBeenCalled();
  });
});

// ── Cost + blast radius ──────────────────────────────────────────────────────

describe('the gate is create-only', () => {
  test('an exact-key resolve to an existing wine never evaluates it', async () => {
    const existing = { _id: 'wine-live', name: 'Chardonnay Reserve', producer: 'Syrah' };
    WineDefinition.findOne.mockReturnValue(findOneChain(existing));

    const res = await findOrCreateWine({ ...BASE, producer: 'Syrah' }, USER, { allowPending: true });

    expect(res).toEqual({ wine: existing, created: false });
    // The reference load is what the evaluation costs; it never happened.
    expect(Grape.find).not.toHaveBeenCalled();
    expect(Region.find).not.toHaveBeenCalled();
  });

  test('a fuzzy auto-match to an existing wine never evaluates it either', async () => {
    const existing = { _id: 'wine-live', name: 'Chardonnay Reserve', producer: 'Syrah' };
    WineDefinition.find.mockImplementation((q) => {
      if (q && q.$text) return { populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([existing]) }) };
      return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue([]) }) };
    });
    scoreAllMatches.mockReturnValue([{ wine: existing, score: 0.99 }]);

    const res = await findOrCreateWine({ ...BASE, producer: 'Syrah' }, USER, { allowPending: true });

    expect(res).toEqual({ wine: existing, created: false });
    expect(Region.find).not.toHaveBeenCalled();
  });

  test('matchOnly callers (the demo clone, resolve_wine) never reach it', async () => {
    const res = await findOrCreateWine({ ...BASE, producer: 'Syrah' }, USER, { matchOnly: true });

    expect(res).toEqual({ wine: null, noMatch: true });
    expect(Region.find).not.toHaveBeenCalled();
  });

  test('ONE evaluation per mint — the reference load is not repeated', async () => {
    await findOrCreateWine({ ...BASE, producer: 'Syrah' }, USER, { allowPending: true });

    // Region/Country are read ONLY by the cross-field reference load on this
    // fixture (grapes[] is empty, so Grape.find is also hit by the inference
    // step — hence the looser assertion there).
    expect(Region.find).toHaveBeenCalledTimes(1);
    expect(Country.find).toHaveBeenCalledTimes(1);
  });
});
