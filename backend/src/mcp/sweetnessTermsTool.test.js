/**
 * list_sweetness_terms — the read-scope label sweetness vocabulary tool. Pins:
 * read scope, scale-then-band order, the scale filter (the same word on two
 * scales), the country filter keeping the country-less rows, the regulated
 * flag, an unknown country is not_found. The table is primed in memory;
 * Country is mocked.
 */
jest.mock('../models/Country', () => ({ findOne: jest.fn(), find: jest.fn() }));

const Country = require('../models/Country');
const ops = require('../services/sweetnessOps');
const { allTools } = require('./registry');
require('./tools/sweetnessTerms');

const tool = () => allTools().find((t) => t.name === 'list_sweetness_terms');
const parse = (res) => JSON.parse(res.content[0].text);
const chain = (rows) => ({ select: () => chain(rows), lean: async () => rows });

const DE = 'd'.repeat(24);
const ROWS = [
  { _id: '1', name: 'Trocken', scale: 'still', band: 'dry', system: 'EU 2019/33 Annex III A (de)', country: null, synonyms: [] },
  { _id: '2', name: 'Feinherb', scale: 'still', band: 'off-dry', system: 'Customary (de)', regulated: false, country: DE, synonyms: [] },
  { _id: '3', name: 'Trocken', scale: 'sparkling', band: 'sec', system: 'EU 2019/33 Annex III B (de)', country: null, synonyms: [] },
  { _id: '4', name: 'Brut Nature', scale: 'sparkling', band: 'brut-nature', system: 'EU 2019/33 Annex III B', country: null, synonyms: ['Brut Zéro'] },
];

beforeEach(() => {
  jest.clearAllMocks();
  ops.primeSweetnessCache(ROWS);
  Country.find.mockReturnValue(chain([{ _id: DE, name: 'Germany' }]));
});
afterEach(() => ops.primeSweetnessCache(null));

test('read scope, read-only, registered', () => {
  const t = tool();
  expect(t).toBeTruthy();
  expect(t.scope).toBe('read');
  expect(t.annotations.readOnlyHint).toBe(true);
});

test('lists every term by scale then band, with its country name, the regulated flag and spellings', async () => {
  const body = parse(await tool().handler({}));
  expect(body.data.terms.map((r) => `${r.scale}:${r.name}`)).toEqual(['sparkling:Brut Nature', 'sparkling:Trocken', 'still:Trocken', 'still:Feinherb']);
  expect(body.data.terms[0]).toEqual({ name: 'Brut Nature', scale: 'sparkling', band: 'brut-nature', regulated: true, system: 'EU 2019/33 Annex III B', country: null, synonyms: ['Brut Zéro'] });
  expect(body.data.terms[3]).toMatchObject({ name: 'Feinherb', regulated: false, country: 'Germany' });
  expect(body.data.scales).toEqual(['still', 'sparkling']);
  expect(body.data.bands.sparkling).toEqual(['brut-nature', 'extra-brut', 'brut', 'extra-dry', 'sec', 'demi-sec', 'doux']);
});

test('the scale filter keeps the word of that scale only', async () => {
  const body = parse(await tool().handler({ scale: 'sparkling' }));
  expect(body.data.terms.map((r) => `${r.name}=${r.band}`)).toEqual(['Brut Nature=brut-nature', 'Trocken=sec']);
});

test('a country keeps its own terms and the country-less ones; an unknown country is not_found', async () => {
  Country.findOne.mockReturnValue(chain({ _id: DE, name: 'Germany' }));
  const body = parse(await tool().handler({ country: 'germany', scale: 'still' }));
  expect(body.data.terms.map((r) => r.name)).toEqual(['Trocken', 'Feinherb']);

  Country.findOne.mockReturnValue(chain(null));
  const res = await tool().handler({ country: 'Atlantis' });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toMatch(/not_found|No country/);
});
