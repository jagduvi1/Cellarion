/**
 * search_bottles → wine detail + resolved maturity on every row (support
 * tickets 6aad5481 + 6aad5c67).
 *
 * Pins: grapes/region/country on the wine object; `maturity` reports the
 * window that governs the bottle (own override first, else the curated
 * sommelier profile) with its status; the own-override fields stay as they
 * were; consumed bottles carry no verdict; a failed profile lookup degrades
 * to a warning, never a failed search.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select', 'distinct']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), searchBottles: jest.fn() }));
jest.mock('../services/photoState', () => ({
  photosForBottle: jest.fn(), photoPresence: jest.fn(async () => new Map()),
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineVintageProfile = require('../models/WineVintageProfile');
const { allTools } = require('./registry');
require('./tools');

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const CTX = { user: { id: 'u'.repeat(24) }, scopes: ['read'] };
const THIS_YEAR = new Date().getFullYear();
const CELLAR_ID = new mongoose.Types.ObjectId();

const mkBottle = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  cellar: CELLAR_ID,
  vintage: '2022',
  status: 'active',
  wineDefinition: {
    _id: new mongoose.Types.ObjectId(),
    name: 'Kirschgarten GG', producer: 'Philipp Kuhn', type: 'white',
    grapes: [{ name: 'Riesling' }], region: { name: 'Pfalz' }, country: { name: 'Germany' },
  },
  ...over,
});

function wire(bottles, profiles = []) {
  Cellar.find.mockReturnValue(chain([CELLAR_ID]));
  Bottle.countDocuments.mockResolvedValue(bottles.length);
  Bottle.find.mockReturnValue(chain(bottles));
  WineVintageProfile.find.mockReturnValue(chain(profiles));
}

beforeEach(() => jest.clearAllMocks());

test('wine carries grapes, region and country', async () => {
  wire([mkBottle()]);
  const row = parse(await tool('search_bottles').handler({}, CTX)).data[0];
  expect(row.wine).toMatchObject({ grapes: ['Riesling'], region: 'Pfalz', country: 'Germany' });
});

test('the curated window shows as maturity while the own-override fields stay null', async () => {
  const b = mkBottle();
  wire([b], [{
    wineDefinition: b.wineDefinition._id, vintage: '2022', status: 'reviewed',
    earlyFrom: THIS_YEAR - 2, earlyUntil: THIS_YEAR + 1, peakFrom: THIS_YEAR + 2, peakUntil: THIS_YEAR + 5,
    lateFrom: THIS_YEAR + 6, lateUntil: THIS_YEAR + 8,
  }]);
  const row = parse(await tool('search_bottles').handler({}, CTX)).data[0];
  expect(row.drink_from).toBeNull();
  expect(row.peak_from).toBeNull();
  expect(row.maturity).toEqual({
    status: 'early', source: 'sommelier',
    drink_from: THIS_YEAR - 2, peak_from: THIS_YEAR + 2, peak_until: THIS_YEAR + 5, drink_to: THIS_YEAR + 8,
  });
});

test('the user\'s own window wins over the curated one', async () => {
  const b = mkBottle({ drinkFrom: THIS_YEAR + 3, drinkTo: THIS_YEAR + 10 });
  wire([b], [{
    wineDefinition: b.wineDefinition._id, vintage: '2022', status: 'reviewed',
    earlyFrom: THIS_YEAR - 2, peakFrom: THIS_YEAR, peakUntil: THIS_YEAR + 3,
  }]);
  const row = parse(await tool('search_bottles').handler({}, CTX)).data[0];
  expect(row.maturity).toMatchObject({ status: 'not-ready', source: 'own', drink_from: THIS_YEAR + 3 });
});

test('no window anywhere → maturity null; consumed bottles carry no maturity at all', async () => {
  const bare = mkBottle();
  const drunk = mkBottle({ status: 'drank' });
  wire([bare, drunk]);
  const rows = parse(await tool('search_bottles').handler({ status: 'all' }, CTX)).data;
  expect(rows[0].maturity).toBeNull();
  expect(rows[1]).not.toHaveProperty('maturity');
});

test('a failed profile lookup drops maturity with a warning, never the page', async () => {
  wire([mkBottle()]);
  WineVintageProfile.find.mockImplementation(() => { throw new Error('db down'); });
  const body = parse(await tool('search_bottles').handler({}, CTX));
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).not.toHaveProperty('maturity');
  expect(body.data[0].wine.grapes).toEqual(['Riesling']);
  expect(body.warnings.join(' ')).toMatch(/Drink-window lookup failed/);
});
