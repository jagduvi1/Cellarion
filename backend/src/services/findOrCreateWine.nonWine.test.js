/**
 * findOrCreateWine's opt-in `nonWine` option: a wine the caller already knows
 * is not a wine (an import row whose Type/Category named a spirit) is BORN
 * flagged, so the one index call a mint makes removes it rather than adding
 * it. Flagging after the mint would race that fire-and-forget call: its "add"
 * could land after the flagging save's "remove" and leave the row publicly
 * searchable.
 *
 * Locked here:
 *   - with nonWine: true the minted row carries the flag from its first save,
 *     and the only index call runs after that save, on a flagged row
 *   - without the option (or with false) the constructed row has no nonWine
 *     key at all: every other caller's create is unchanged
 *   - a MATCH ignores the option: an existing wine is never flagged here
 *
 * Same mocking strategy as findOrCreateWine.pendingIdentity.test.js.
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

const SPIRIT = {
  name: 'Highland Single Malt 12',
  producer: 'Glen Fictif',
  country: 'United Kingdom',
  region: 'Scotland',
  appellation: '',
  type: 'red',
  grapes: [],
};

const chain = (rows) => {
  const c = {};
  for (const m of ['select', 'sort', 'limit', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn().mockResolvedValue(rows);
  return c;
};

function primeFind({ canonicalHits = [] } = {}) {
  WineDefinition.find.mockImplementation((q) => {
    if (q && q.canonicalKey) {
      const docs = q.canonicalKey instanceof RegExp ? [] : canonicalHits;
      return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue(docs) }) };
    }
    if (q && q.normalizedKey) {
      return { limit: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue([]) }) };
    }
    if (q && q.$text) {
      return { populate: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) };
    }
    return { populate: jest.fn().mockResolvedValue([]) };
  });
}

// What the row looked like when it was saved, and what the index was asked to
// do and with which state of the row.
let saved;
let indexed;
let instance;
let warnSpy;

afterEach(() => warnSpy.mockRestore());

beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  saved = [];
  indexed = [];
  instance = null;

  WineDefinition.mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'wine-new';
    this.save = jest.fn(async () => { saved.push({ nonWine: this.nonWine }); return this; });
    this.populate = jest.fn().mockResolvedValue(this);
    instance = this;
  });
  for (const [Model, prefix] of [[Country, 'country'], [Region, 'region'], [Grape, 'grape']]) {
    Model.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this._id = `${prefix}-new`;
      this.save = jest.fn().mockResolvedValue(this);
    });
  }
  // indexWine reads the row back by id and adds it or removes it on its flags
  // (services/search). Record the row's state at the moment of the call.
  searchService.indexWine.mockImplementation((id) => {
    indexed.push({ id, nonWine: instance ? instance.nonWine : undefined, savesBefore: saved.length });
  });

  WineDefinition.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
  WineDefinition.aggregate.mockResolvedValue([]);
  Appellation.find.mockReturnValue(chain([]));
  Region.find.mockReturnValue(chain([]));
  Country.find.mockReturnValue(chain([]));
  Grape.find.mockReturnValue(chain([]));
  searchService.getIsAvailable.mockReturnValue(false);
  primeFind();
  scoreAllMatches.mockReturnValue([]);

  Country.findOne.mockResolvedValue({ _id: 'country-1' });
  Region.findOne.mockResolvedValue({ _id: 'region-1' });
  Country.exists.mockResolvedValue(null);
  Region.exists.mockResolvedValue(null);
  Appellation.exists.mockResolvedValue(null);
  Grape.findOne.mockResolvedValue(null);
});

describe('findOrCreateWine — the nonWine option', () => {
  test('a mint with nonWine: true is saved flagged and indexed once, after that save', async () => {
    const res = await findOrCreateWine(SPIRIT, USER, { createdVia: 'import', allowPending: true, nonWine: true });

    expect(res.created).toBe(true);
    expect(WineDefinition).toHaveBeenCalledTimes(1);
    expect(WineDefinition.mock.calls[0][0].nonWine).toBe(true);
    expect(saved).toEqual([{ nonWine: true }]);
    // The one index call sees a flagged row, so it removes rather than adds:
    // the row is never sent to the search index as a visible document.
    expect(indexed).toEqual([{ id: 'wine-new', nonWine: true, savesBefore: 1 }]);
  });

  test.each([
    ['absent', {}],
    ['false', { nonWine: false }],
  ])('with the option %s the created row carries no nonWine key at all', async (_label, extra) => {
    const res = await findOrCreateWine(SPIRIT, USER, { createdVia: 'import', allowPending: true, ...extra });

    expect(res.created).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(WineDefinition.mock.calls[0][0], 'nonWine')).toBe(false);
    expect(indexed).toHaveLength(1);
  });

  test('a match ignores the option: the existing wine is returned untouched', async () => {
    const existing = { _id: 'wine-existing', name: SPIRIT.name, producer: SPIRIT.producer, nonWine: false };
    primeFind({ canonicalHits: [existing] });

    const res = await findOrCreateWine(SPIRIT, USER, { createdVia: 'import', allowPending: true, nonWine: true });

    expect(res.created).toBe(false);
    expect(res.wine).toBe(existing);
    expect(existing.nonWine).toBe(false);
    expect(WineDefinition).not.toHaveBeenCalled();
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });
});
