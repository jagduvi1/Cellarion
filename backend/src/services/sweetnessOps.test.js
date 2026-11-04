/**
 * Label sweetness — the term table and its readers (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * The same word means two things on two scales (German "trocken" is the dry
 * band on a still wine and the sec band on a Sekt), ß is a letter
 * normalizeString would delete, a listed spelling must resolve to its row, and
 * every wine read sends one shape. The seed is checked row by row against the
 * model's scales and bands, and the boot rule — seed only a registry with no
 * rows — is pinned, because a registry with rows keeps what its admin chose.
 */
jest.mock('../models/SweetnessTerm', () => {
  const Actual = jest.requireActual('../models/SweetnessTerm');
  Actual.estimatedDocumentCount = jest.fn();
  Actual.findOne = jest.fn();
  Actual.create = jest.fn();
  return Actual;
});

const SweetnessTerm = require('../models/SweetnessTerm');
const ops = require('./sweetnessOps');
const seed = require('../data/sweetness-terms.json');

const ROWS = [
  { _id: 's1', name: 'Trocken', scale: 'still', band: 'dry', country: null, synonyms: [] },
  { _id: 'p1', name: 'Trocken', scale: 'sparkling', band: 'sec', country: null, synonyms: [] },
  { _id: 's2', name: 'Süß', scale: 'still', band: 'sweet', country: null, synonyms: ['Suess'] },
  { _id: 'p2', name: 'Brut Nature', scale: 'sparkling', band: 'brut-nature', country: null, synonyms: ['Brut Zéro'] },
  { _id: 's3', name: 'Feinherb', scale: 'still', band: 'off-dry', regulated: false, country: null, synonyms: [] },
];

beforeEach(() => {
  jest.clearAllMocks();
  ops.primeSweetnessCache(ROWS);
});
afterEach(() => ops.primeSweetnessCache(null));

describe('scaleForType', () => {
  test('sparkling wines are on the dosage scale, every other wine on the still scale, fortified and non-wine on none', () => {
    expect(ops.scaleForType('sparkling')).toBe('sparkling');
    for (const t of ['red', 'white', 'rosé', 'dessert']) expect(ops.scaleForType(t)).toBe('still');
    expect(ops.scaleForType('fortified')).toBeNull();
    expect(ops.scaleForType(undefined)).toBeNull();
    expect(ops.scaleForType('red', { nonWine: true })).toBeNull();
  });
});

describe('resolveTerm', () => {
  test('the same word resolves by scale: trocken is dry on a still wine and sec on a Sekt', async () => {
    expect((await ops.resolveTerm('trocken', { scale: 'still' }))._id).toBe('s1');
    expect((await ops.resolveTerm('TROCKEN', { scale: 'sparkling' })).band).toBe('sec');
  });

  test('without a scale a word on two scales is ambiguous, a word on one is not', async () => {
    expect(await ops.resolveTerm('trocken')).toBeNull();
    expect((await ops.resolveTerm('Brut Nature'))._id).toBe('p2');
  });

  test('ß resolves, as does an accepted spelling', async () => {
    expect((await ops.resolveTerm('süß', { scale: 'still' }))._id).toBe('s2');
    expect((await ops.resolveTerm('Suess', { scale: 'still' }))._id).toBe('s2');
    expect((await ops.resolveTerm('brut zero', { scale: 'sparkling' }))._id).toBe('p2');
  });

  test('an unknown word and an empty word are null', async () => {
    expect(await ops.resolveTerm('lieblich', { scale: 'still' })).toBeNull();
    expect(await ops.resolveTerm('', { scale: 'still' })).toBeNull();
    expect(await ops.resolveTerm(null)).toBeNull();
  });

  test('without a database connection the table is empty and nothing resolves', async () => {
    ops.primeSweetnessCache(null);
    const terms = await ops.loadTerms();
    expect(terms.empty).toBe(true);
    expect(await ops.resolveTerm('trocken', { scale: 'still' })).toBeNull();
  });
});

describe('the API shape', () => {
  test('a populated term is { name, band, scale, regulated }; a customary word says so', () => {
    expect(ops.labelSweetnessOut({ labelSweetness: ROWS[0] })).toEqual({ name: 'Trocken', band: 'dry', scale: 'still', regulated: true });
    expect(ops.labelSweetnessOut({ labelSweetness: ROWS[4] })).toEqual({ name: 'Feinherb', band: 'off-dry', scale: 'still', regulated: false });
  });

  test('no term, an unpopulated ref and no wine are null — never a claim', () => {
    expect(ops.labelSweetnessOut({ labelSweetness: null })).toBeNull();
    expect(ops.labelSweetnessOut({ labelSweetness: { _id: 'x' } })).toBeNull();
    expect(ops.labelSweetnessOut(null)).toBeNull();
  });

  test('the display name is the name as the label reads it, never doubled', () => {
    expect(ops.wineDisplayName({ name: 'Riesling Kabinett', labelSweetness: { name: 'Trocken' } })).toBe('Riesling Kabinett Trocken');
    expect(ops.wineDisplayName({ name: 'Riesling Kabinett trocken', labelSweetness: { name: 'Trocken' } })).toBe('Riesling Kabinett trocken');
    expect(ops.wineDisplayName({ name: 'Brut Premier', labelSweetness: { name: 'Brut' } })).toBe('Brut Premier');
    expect(ops.wineDisplayName({ name: 'Salmos', labelSweetness: null })).toBe('Salmos');
    expect(ops.wineDisplayName({ name: 'Salmos', labelSweetness: { _id: 'unpopulated' } })).toBe('Salmos');
    expect(ops.wineDisplayName(null)).toBe('');
  });
});

describe('the seed', () => {
  test('every row has a scale the model knows and a band of that scale; a word appears once per scale', () => {
    const seen = new Set();
    for (const r of seed) {
      expect(SweetnessTerm.SCALES).toContain(r.scale);
      expect(SweetnessTerm.BANDS[r.scale]).toContain(r.band);
      const key = `${r.scale}:${r.name.toLowerCase()}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test('the German word on both scales, the customary words unregulated', () => {
    const trocken = seed.filter((r) => r.name === 'Trocken');
    expect(trocken.map((r) => [r.scale, r.band]).sort()).toEqual([['sparkling', 'sec'], ['still', 'dry']]);
    expect(seed.find((r) => r.name === 'Feinherb').regulated).toBe(false);
    expect(seed.find((r) => r.name === 'Off-Dry').regulated).toBe(false);
    expect(seed.find((r) => r.name === 'Brut Nature').regulated).not.toBe(false);
  });

  test('boot seeds a registry with no rows and leaves one with rows alone', async () => {
    SweetnessTerm.estimatedDocumentCount.mockResolvedValue(0);
    SweetnessTerm.findOne.mockResolvedValue(null);
    SweetnessTerm.create.mockResolvedValue({});
    expect(await ops.ensureSweetnessSeed()).toEqual({ seeded: true, created: seed.length, updated: 0 });
    const rows = SweetnessTerm.create.mock.calls.map((c) => c[0]);
    expect(rows.find((r) => r.name === 'Süß')).toMatchObject({ normalizedName: 'suss', scale: 'still', band: 'sweet', createdByUser: false });

    jest.clearAllMocks();
    SweetnessTerm.estimatedDocumentCount.mockResolvedValue(seed.length);
    expect(await ops.ensureSweetnessSeed()).toEqual({ seeded: false });
    expect(SweetnessTerm.create).not.toHaveBeenCalled();
  });
});
