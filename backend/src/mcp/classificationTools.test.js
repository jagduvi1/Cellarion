/**
 * list_classifications — the read-scope classification taxonomy tool. Pins:
 * read scope (never anonymous), the country filter keeps the country's own
 * tiers plus the country-less ones, the kind filter, kind-ordered output
 * shaped for a client, an unknown country is not_found. The taxonomy is
 * primed in memory; Country is mocked.
 */
jest.mock('../models/Classification', () => ({ find: jest.fn(), findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn(), find: jest.fn() }));

const Country = require('../models/Country');
const ops = require('../services/classificationOps');
const { allTools } = require('./registry');
require('./tools/classifications');

const tool = () => allTools().find((t) => t.name === 'list_classifications');
const parse = (res) => JSON.parse(res.content[0].text);
const chain = (rows) => ({ select: () => chain(rows), lean: async () => rows });

const DE = 'd'.repeat(24);
const AT = 'a'.repeat(24);
const ROWS = [
  { _id: '1', name: 'Spätlese', kind: 'ripeness', system: 'Prädikatswein', country: null, synonyms: ['Spatlese'] },
  { _id: '2', name: 'VDP Grosse Lage', kind: 'vineyard_rank', system: 'VDP', country: DE, synonyms: ['Grosse Lage'] },
  { _id: '3', name: 'Smaragd', kind: 'ripeness', system: 'Vinea Wachau', country: AT, synonyms: [] },
  { _id: '4', name: 'Reserve', kind: 'other', system: null, country: null, synonyms: [] },
];

beforeEach(() => {
  jest.clearAllMocks();
  ops.primeClassificationCache(ROWS);
  Country.find.mockReturnValue(chain([{ _id: DE, name: 'Germany' }, { _id: AT, name: 'Austria' }]));
});
afterEach(() => ops.primeClassificationCache(null));

test('read scope, read-only, registered', () => {
  const t = tool();
  expect(t).toBeTruthy();
  expect(t.scope).toBe('read');
  expect(t.annotations.readOnlyHint).toBe(true);
});

test('lists every tier in kind order with its country name and spellings', async () => {
  const body = parse(await tool().handler({}));
  expect(body.data.classifications.map((c) => c.name)).toEqual(['VDP Grosse Lage', 'Smaragd', 'Spätlese', 'Reserve']);
  expect(body.data.classifications[0]).toEqual({ name: 'VDP Grosse Lage', kind: 'vineyard_rank', system: 'VDP', country: 'Germany', synonyms: ['Grosse Lage'] });
  expect(body.data.kinds).toEqual(['vineyard_rank', 'ripeness', 'ageing', 'other']);
});

test('a country keeps its own tiers and the country-less ones; a kind narrows further', async () => {
  Country.findOne.mockReturnValue(chain({ _id: AT, name: 'Austria' }));
  const body = parse(await tool().handler({ country: 'austria' }));
  expect(body.data.classifications.map((c) => c.name)).toEqual(['Smaragd', 'Spätlese', 'Reserve']);
  const ripe = parse(await tool().handler({ country: 'Austria', kind: 'ripeness' }));
  expect(ripe.data.classifications.map((c) => c.name)).toEqual(['Smaragd', 'Spätlese']);
});

test('an unknown country is not_found', async () => {
  Country.findOne.mockReturnValue(chain(null));
  const res = await tool().handler({ country: 'Atlantis' });
  expect(res.isError).toBe(true);
  expect(parse(res).error.code).toBe('not_found');
});
