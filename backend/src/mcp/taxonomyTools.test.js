/**
 * describe_grape / describe_region / describe_country — the read-scope
 * taxonomy lookup tools. Pins: they are 'read' (never on the anonymous public
 * surface), synonym lookup resolves ("Shiraz" → Syrah), region-name collisions
 * across countries return the highest-wine-count match with a warning, and the
 * shaped output never leaks internal fields. Models are mocked; normalizeString
 * is the real implementation so the lookup keys are exercised for real.
 */
const chain = (result) => {
  const c = {
    select: jest.fn(() => c),
    populate: jest.fn(() => c),
    sort: jest.fn(() => c),
    limit: jest.fn(() => c),
    lean: jest.fn(() => Promise.resolve(result)),
  };
  return c;
};

jest.mock('../models/Grape', () => ({ findOne: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ countDocuments: jest.fn() }));

const Grape = require('../models/Grape');
const Region = require('../models/Region');
const Country = require('../models/Country');
const WineDefinition = require('../models/WineDefinition');
const { allTools } = require('./registry');
require('./tools/taxonomy');

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const oid = (c) => c.repeat(24);

beforeEach(() => jest.clearAllMocks());

describe('scope & shape', () => {
  test('all three are read-scoped and read-only (never anonymous/public)', () => {
    for (const name of ['describe_grape', 'describe_region', 'describe_country']) {
      const t = tool(name);
      expect(t).toBeTruthy();
      expect(t.scope).toBe('read');
      expect(t.scope).not.toBe('public');
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });
});

describe('describe_grape', () => {
  test('resolves by synonym and shapes the profile', async () => {
    Grape.findOne.mockReturnValue(chain({
      _id: oid('a'), name: 'Syrah', slug: 'syrah', color: 'Red', origin: 'France (Northern Rhône)',
      characteristics: ['black pepper'], agingPotential: 'Excellent', prestige: null,
      synonyms: ['Shiraz'], description: '**Syrah** is a red grape.',
    }));
    WineDefinition.countDocuments.mockResolvedValue(340);

    const res = await tool('describe_grape').handler({ grape: 'Shiraz' });
    const { data } = parse(res);

    // lookup used a normalized $or over name/synonyms/slug
    const q = Grape.findOne.mock.calls[0][0];
    expect(q.$or).toEqual(expect.arrayContaining([
      { normalizedName: 'shiraz' }, { normalizedSynonyms: 'shiraz' }, { slug: 'shiraz' },
    ]));
    expect(data).toMatchObject({
      name: 'Syrah', color: 'Red', synonyms: ['Shiraz'], wine_count: 340,
      description: '**Syrah** is a red grape.',
    });
    expect(data.public_url).toMatch(/\/grapes\/syrah$/);
  });

  test('unknown grape → not_found, no count query', async () => {
    Grape.findOne.mockReturnValue(chain(null));
    const res = await tool('describe_grape').handler({ grape: 'Nonesuch' });
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('not_found');
    expect(WineDefinition.countDocuments).not.toHaveBeenCalled();
  });

  test('blank input → invalid_input', async () => {
    const res = await tool('describe_grape').handler({ grape: '   ' });
    expect(parse(res).error.code).toBe('invalid_input');
    expect(Grape.findOne).not.toHaveBeenCalled();
  });
});

describe('describe_region', () => {
  test('name colliding across countries returns the highest-wine-count match with a warning', async () => {
    Region.find.mockReturnValue(chain([
      { _id: oid('1'), name: 'Rioja', slug: 'rioja', styles: [], typicalGrapes: [], country: { name: 'Argentina' } },
      { _id: oid('2'), name: 'Rioja', slug: 'rioja-2', styles: [], typicalGrapes: [{ name: 'Tempranillo' }], country: { name: 'Spain' } },
    ]));
    // counts are fetched per match, in order
    WineDefinition.countDocuments
      .mockResolvedValueOnce(1)   // Argentina Rioja
      .mockResolvedValueOnce(46); // Spain Rioja

    const res = await tool('describe_region').handler({ region: 'Rioja' });
    const out = parse(res);
    expect(out.data.country).toBe('Spain');
    expect(out.data.wine_count).toBe(46);
    expect(out.data.typical_grapes).toEqual(['Tempranillo']);
    expect(out.warnings[0]).toMatch(/exists in 2 countries/);
    expect(Country.findOne).not.toHaveBeenCalled();
  });

  test('country filter disambiguates and is applied to the region query', async () => {
    Country.findOne.mockReturnValue(chain({ _id: oid('c'), name: 'Spain' }));
    Region.find.mockReturnValue(chain([
      { _id: oid('2'), name: 'Rioja', slug: 'rioja', styles: [], typicalGrapes: [], country: { name: 'Spain' } },
    ]));
    WineDefinition.countDocuments.mockResolvedValue(46);

    const res = await tool('describe_region').handler({ region: 'Rioja', country: 'ES' });
    expect(res.isError).toBeUndefined();
    // the region query carried the resolved country id
    expect(Region.find.mock.calls[0][0].country).toBe(oid('c'));
    expect(parse(res).warnings).toBeUndefined(); // single match → no collision note
  });

  test('unknown country → not_found before touching regions', async () => {
    Country.findOne.mockReturnValue(chain(null));
    const res = await tool('describe_region').handler({ region: 'Rioja', country: 'Atlantis' });
    expect(parse(res).error.code).toBe('not_found');
    expect(Region.find).not.toHaveBeenCalled();
  });
});

describe('describe_country', () => {
  test('resolves by ISO code and returns region + wine counts', async () => {
    Country.findOne.mockReturnValue(chain({
      _id: oid('c'), name: 'Germany', slug: 'germany', code: 'DE', description: '**Germany** — Riesling.',
    }));
    Region.countDocuments.mockResolvedValue(20);
    WineDefinition.countDocuments.mockResolvedValue(320);

    const res = await tool('describe_country').handler({ country: 'de' });
    const { data } = parse(res);
    const q = Country.findOne.mock.calls[0][0];
    expect(q.$or).toEqual(expect.arrayContaining([{ code: 'DE' }]));
    expect(data).toMatchObject({ name: 'Germany', code: 'DE', region_count: 20, wine_count: 320 });
    expect(data.public_url).toMatch(/\/countries\/germany$/);
  });

  test('unknown country → not_found', async () => {
    Country.findOne.mockReturnValue(chain(null));
    const res = await tool('describe_country').handler({ country: 'Atlantis' });
    expect(parse(res).error.code).toBe('not_found');
  });
});
