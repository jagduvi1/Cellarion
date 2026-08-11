/**
 * Pending-identity minting — the "a bottle add must never fail because a label
 * was unreadable" path.
 *
 * Two contracts are pinned here and they pull in opposite directions:
 *
 *   allowPending (COMMIT paths: bottle/wishlist/MCP add, import) — a missing,
 *   sentinel, unusable or geography-as-producer identity mints a
 *   pendingIdentity row instead of throwing. The producer is NEVER stored, the
 *   geography is moved to the field it belongs in when that field is free, and
 *   the row keys under a namespace no real producer can occupy.
 *
 *   NO allowPending (deliberate shared-registry CURATION: admin wine create,
 *   admin wine-request approval, MCP admin_add_registry_wine) — the gates throw
 *   exactly as they always have. The messages are pinned BYTE-FOR-BYTE because
 *   a curator typing "Bordeaux" as a producer should be told so, and because
 *   those strings are what the admin UIs surface.
 *
 * Plus dedup ISOLATION in both directions: a pending row is invisible to other
 * creators at every match stage, and visible to its own creator at all of them
 * (which is what makes a retry resolve instead of minting again).
 *
 * Same mocking strategy as findOrCreateWine.test.js — real normalize utils,
 * mocked scorer — so keys and sentinels are exercised for real.
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
const { normalizeString } = require('../utils/normalize');
const { findOrCreateWine, pendingProducerKey } = require('./findOrCreateWine');

const USER = '507f1f77bcf86cd799439011';
const OTHER_USER = '507f1f77bcf86cd799439022';

const BASE = {
  name: 'Kaefferkopf',
  producer: 'Cave de Kaysersberg',
  country: 'France',
  region: 'Alsace',
  appellation: '',
  type: 'white',
  grapes: [],
};

const findOneChain = (doc) => ({ populate: jest.fn().mockResolvedValue(doc) });

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

/** The document the mocked constructor was called with on a create. */
const minted = () => WineDefinition.mock.calls[0][0];

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
  Appellation.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  });
  searchService.getIsAvailable.mockReturnValue(false);
  primeFind();
  scoreAllMatches.mockReturnValue([]);

  Country.findOne.mockResolvedValue({ _id: 'country-1' });
  Region.findOne.mockResolvedValue({ _id: 'region-1' });
  Country.exists.mockResolvedValue(null);
  Region.exists.mockResolvedValue(null);
  Appellation.exists.mockResolvedValue(null);
  Grape.findOne.mockImplementation(async (q) => {
    const normalizedName = q.$or ? q.$or[0].normalizedName : q.normalizedName;
    return { _id: `grape-${normalizedName}` };
  });
  // Grape INFERENCE from the name runs whenever grapes[] is empty (which every
  // fixture here is) — an empty taxonomy means "nothing inferred".
  Grape.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  });
});

/**
 * Re-arm the doc-constructor + default lookups after a mid-test
 * jest.clearAllMocks(). Used by the both-directions isolation tests, which
 * need two independent runs inside one test body.
 */
function rearm() {
  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
  });
  WineDefinition.findOne.mockReturnValue(findOneChain(null));
  WineDefinition.aggregate.mockResolvedValue([]);
  Appellation.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  });
  Country.findOne.mockResolvedValue({ _id: 'country-1' });
  Region.findOne.mockResolvedValue({ _id: 'region-1' });
  Country.exists.mockResolvedValue(null);
  Region.exists.mockResolvedValue(null);
  Appellation.exists.mockResolvedValue(null);
  Grape.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  });
  searchService.getIsAvailable.mockReturnValue(false);
  scoreAllMatches.mockReturnValue([]);
}

afterEach(() => warnSpy.mockRestore());

// ── Pending mint: missing + sentinel producers ───────────────────────────────

describe('allowPending — an incomplete producer mints a pending row instead of throwing', () => {
  test.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['punctuation only', '-'],
    ['question mark', '?'],
    ['unknown', 'Unknown'],
    ['UNKNOWN (case)', 'UNKNOWN'],
    ['n/a', 'N/A'],
    ['na', 'na'],
    ['none', 'none'],
    ['unbekannt', 'unbekannt'],
    ['inconnu', 'Inconnu'],
    ['okänd (diacritics folded)', 'Okänd'],
    ['okand', 'okand'],
    ['domaine unknown', 'Domaine Unknown'],
    ['producer unknown', 'Producer Unknown'],
    ['no producer', 'No Producer'],
  ])('%s → pendingIdentity, and the sentinel is NEVER stored', async (_label, producer) => {
    const res = await findOrCreateWine({ ...BASE, producer }, USER, { allowPending: true });

    expect(res.created).toBe(true);
    expect(res.pendingIdentity).toBe(true);
    const doc = minted();
    expect(doc.pendingIdentity).toBe(true);
    // The empty string, not the sentinel and not the field's absence.
    expect(doc.producer).toBe('');
    expect(doc.name).toBe('Kaefferkopf');
  });

  test('a real producer is unaffected — no pending flag, no key change', async () => {
    const res = await findOrCreateWine(BASE, USER, { allowPending: true });

    expect(res.pendingIdentity).toBeUndefined();
    const doc = minted();
    expect(doc.pendingIdentity).toBe(false);
    expect(doc.producer).toBe('Cave de Kaysersberg');
    expect(doc.normalizedKey.startsWith('cave de kaysersberg:')).toBe(true);
  });
});

// ── The missing-producer key namespace ───────────────────────────────────────

describe('the pending key namespace cannot collide with real producers or other creators', () => {
  test('the producer segment carries the creator id and a character normalizeString can never emit', async () => {
    await findOrCreateWine({ ...BASE, producer: 'Unknown' }, USER, { allowPending: true });

    const key = minted().normalizedKey;
    expect(key).toBe(`${pendingProducerKey(USER)}:kaefferkopf:`);
    expect(key.startsWith('pending~')).toBe(true);
    // The collision argument, executed: normalizeString strips '~', so NO
    // producer string can ever normalize into this namespace.
    expect(normalizeString('pending~anything')).not.toContain('~');
  });

  test('two creators with the SAME producerless identity key differently', async () => {
    await findOrCreateWine({ ...BASE, producer: '' }, USER, { allowPending: true });
    const mine = minted().normalizedKey;

    WineDefinition.mockClear();
    await findOrCreateWine({ ...BASE, producer: '' }, OTHER_USER, { allowPending: true });
    const theirs = WineDefinition.mock.calls[0][0].normalizedKey;

    expect(mine).not.toBe(theirs);
  });

  test('two producerless wines with DIFFERENT names key differently for the same creator', async () => {
    await findOrCreateWine({ ...BASE, producer: '', name: 'Kaefferkopf' }, USER, { allowPending: true });
    const a = minted().normalizedKey;

    WineDefinition.mockClear();
    await findOrCreateWine({ ...BASE, producer: '', name: 'Schlossberg' }, USER, { allowPending: true });
    const b = WineDefinition.mock.calls[0][0].normalizedKey;

    expect(a).not.toBe(b);
  });

  test('the same creator re-submitting the same identity RESOLVES to their own row (no retry storm)', async () => {
    const own = { _id: 'wine-pending', pendingIdentity: true, createdBy: USER, name: 'Kaefferkopf' };
    WineDefinition.findOne.mockReturnValue(findOneChain(own));

    const res = await findOrCreateWine({ ...BASE, producer: 'Unknown' }, USER, { allowPending: true });

    expect(res).toEqual({ wine: own, created: false });
    expect(WineDefinition).not.toHaveBeenCalled();
    // …and it looked the row up under the pending namespace, not ':name:'.
    expect(WineDefinition.findOne.mock.calls[0][0].normalizedKey)
      .toBe(`${pendingProducerKey(USER)}:kaefferkopf:`);
  });
});

// ── Geography-as-producer ────────────────────────────────────────────────────

describe('geography-as-producer with allowPending: MOVE it, then go pending', () => {
  test('a country in the producer box moves to an EMPTY country field', async () => {
    Country.exists.mockResolvedValue({ _id: 'c' });

    await findOrCreateWine(
      { ...BASE, producer: 'Portugal', country: '' },
      USER,
      { allowPending: true },
    );

    // Resolution ran against the moved value, not the empty original.
    expect(Country.findOne).toHaveBeenCalled();
    expect(minted().pendingIdentity).toBe(true);
    expect(minted().producer).toBe('');
  });

  test('a region in the producer box moves to an EMPTY region field', async () => {
    Region.exists.mockResolvedValue({ _id: 'r' });

    await findOrCreateWine(
      { ...BASE, producer: 'Douro', region: '' },
      USER,
      { allowPending: true },
    );

    // findOrCreateRegion was asked to resolve the MOVED string.
    expect(Region.findOne).toHaveBeenCalledWith(expect.objectContaining({
      $or: expect.arrayContaining([{ normalizedName: 'douro' }]),
    }));
    expect(minted().pendingIdentity).toBe(true);
    expect(minted().producer).toBe('');
  });

  test('an appellation in the producer box moves to an EMPTY appellation field', async () => {
    Appellation.exists.mockResolvedValue({ _id: 'a' });

    await findOrCreateWine(
      { ...BASE, producer: 'Barolo', appellation: '' },
      USER,
      { allowPending: true },
    );

    expect(minted().appellation).toBe('Barolo');
    expect(minted().pendingIdentity).toBe(true);
    expect(minted().producer).toBe('');
  });

  test('an OCCUPIED target keeps its own value — the misplaced producer is just dropped', async () => {
    Region.exists.mockResolvedValue({ _id: 'r' });

    await findOrCreateWine(
      { ...BASE, producer: 'Douro', region: 'Alsace' },
      USER,
      { allowPending: true },
    );

    // The region query used the ORIGINAL region, not the moved producer.
    expect(Region.findOne).toHaveBeenCalledWith(expect.objectContaining({
      $or: expect.arrayContaining([{ normalizedName: 'alsace' }]),
    }));
    expect(minted().pendingIdentity).toBe(true);
    expect(minted().producer).toBe('');
  });

  test('an occupied APPELLATION target keeps its own value', async () => {
    Appellation.exists.mockResolvedValue({ _id: 'a' });

    await findOrCreateWine(
      { ...BASE, producer: 'Barolo', appellation: 'Barbaresco' },
      USER,
      { allowPending: true },
    );

    expect(minted().appellation).toBe('Barbaresco');
    expect(minted().pendingIdentity).toBe(true);
  });

  test('an unusable (sub-2-char) producer goes pending rather than 400', async () => {
    const res = await findOrCreateWine({ ...BASE, producer: 'X' }, USER, { allowPending: true });

    expect(res.pendingIdentity).toBe(true);
    expect(minted().producer).toBe('');
  });
});

// ── The strict path is untouched ─────────────────────────────────────────────

describe('WITHOUT allowPending the curation gates throw byte-identical 400s', () => {
  test('place-as-producer message is unchanged, character for character', async () => {
    Region.exists.mockResolvedValue({ _id: 'r' });

    await expect(findOrCreateWine({ ...BASE, producer: 'Bordeaux' }, USER))
      .rejects.toMatchObject({
        status: 400,
        message: '"Bordeaux" is a wine region, not a producer — put the actual winery in the producer field',
      });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test.each([
    ['country', () => Country.exists.mockResolvedValue({ _id: 'c' })],
    ['region', () => Region.exists.mockResolvedValue({ _id: 'r' })],
    ['appellation', () => Appellation.exists.mockResolvedValue({ _id: 'a' })],
  ])('a producer that is a known %s still throws', async (_label, prime) => {
    prime();
    await expect(findOrCreateWine({ ...BASE, producer: 'Bordeaux' }, USER))
      .rejects.toMatchObject({ status: 400 });
  });

  test('unusable-producer message is unchanged, character for character', async () => {
    await expect(findOrCreateWine({ ...BASE, producer: 'X' }, USER))
      .rejects.toMatchObject({
        status: 400,
        message: '"X" is not a usable producer name',
      });
    expect(WineDefinition).not.toHaveBeenCalled();
  });

  test('a sentinel producer is NOT treated as missing — it hits the normal gates', async () => {
    // 'Unknown' normalizes to 7 chars, so it passes the length gate and is
    // stored as a producer, exactly as before this feature. Curation surfaces
    // catch it in the cross-field scan (producerPlaceholder rule).
    const res = await findOrCreateWine({ ...BASE, producer: 'Unknown' }, USER);
    expect(res.created).toBe(true);
    expect(minted().pendingIdentity).toBe(false);
    expect(minted().producer).toBe('Unknown');
  });
});

// ── Dedup isolation, both directions ─────────────────────────────────────────

describe('pending rows are isolated from OTHER creators at every match stage', () => {
  const pendingRow = (createdBy) => ({
    _id: 'wine-pending', name: 'Kaefferkopf', producer: '',
    pendingIdentity: true, createdBy,
  });

  test('exact normalizedKey hit belonging to another creator is ignored', async () => {
    WineDefinition.findOne.mockReturnValue(findOneChain(pendingRow(OTHER_USER)));

    const res = await findOrCreateWine(BASE, USER, { allowPending: true });

    expect(res.created).toBe(true);           // fell through and minted its own
    expect(res.wine._id).toBe('wine-new');
  });

  test('exact normalizedKey hit belonging to the SAME creator IS used', async () => {
    const own = pendingRow(USER);
    WineDefinition.findOne.mockReturnValue(findOneChain(own));

    const res = await findOrCreateWine(BASE, USER, { allowPending: true });

    expect(res).toEqual({ wine: own, created: false });
  });

  test('canonical-identity hit is gated by creator', async () => {
    primeFind({ canonicalHits: [pendingRow(OTHER_USER)] });
    const blocked = await findOrCreateWine(BASE, USER, { allowPending: true });
    expect(blocked.created).toBe(true);

    jest.clearAllMocks();
    rearm();
    const own = pendingRow(USER);
    primeFind({ canonicalHits: [own] });
    const allowed = await findOrCreateWine(BASE, USER, { allowPending: true });
    expect(allowed).toEqual({ wine: own, created: false });
  });

  test('sibling match is gated by creator (canonical prefix AND raw-key fallback)', async () => {
    primeFind({ canonicalSiblings: [pendingRow(OTHER_USER)] });
    expect((await findOrCreateWine(BASE, USER, { allowPending: true })).created).toBe(true);

    jest.clearAllMocks();
    rearm();
    primeFind({ siblings: [pendingRow(OTHER_USER)] });
    expect((await findOrCreateWine(BASE, USER, { allowPending: true })).created).toBe(true);
  });

  test('the SOFT ZONE never shows a stranger a pending row — not even as a candidate', async () => {
    const stranger = { ...pendingRow(OTHER_USER), _id: 'wine-theirs' };
    searchService.getIsAvailable.mockReturnValue(false);
    primeFind({ textDocs: [stranger] });
    // If it were scored, 0.90 would put it squarely in the soft zone.
    scoreAllMatches.mockReturnValue([{ wine: stranger, score: 0.9 }]);

    const res = await findOrCreateWine(BASE, USER, { allowPending: true });

    expect(res.candidates).toBeUndefined();
    expect(res.created).toBe(true);
    // The scorer never even saw it — it was filtered out of the candidate pool.
    expect(scoreAllMatches).not.toHaveBeenCalled();
  });

  test('the soft zone DOES show the creator their own pending row', async () => {
    const own = { ...pendingRow(USER), _id: 'wine-mine' };
    searchService.getIsAvailable.mockReturnValue(false);
    primeFind({ textDocs: [own] });
    scoreAllMatches.mockReturnValue([{ wine: own, score: 0.9 }]);

    const res = await findOrCreateWine(BASE, USER, { allowPending: true });

    expect(res.candidates).toEqual([{ wine: own, score: 0.9 }]);
  });

  test('a NON-pending row is never filtered — ordinary dedup is untouched', async () => {
    const normal = { _id: 'wine-live', name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' };
    WineDefinition.findOne.mockReturnValue(findOneChain(normal));

    const res = await findOrCreateWine(BASE, OTHER_USER, { allowPending: true });

    expect(res).toEqual({ wine: normal, created: false });
  });
});
