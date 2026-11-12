/**
 * Label sweetness — the term table and its readers (GitHub discussion #1754).
 *
 * WHY THIS TEST EXISTS:
 * The same word means two things on two scales (German "trocken" is the dry
 * band on a still wine and the sec band on a Sekt), a fortified wine has no
 * scale at all, ß is a letter normalizeString would delete, a listed spelling
 * must resolve to its row, and every wine read sends one shape — honestly: a
 * read that never loaded the field says nothing. The seed is checked row by
 * row against the model's scales and bands, for one word per scale across
 * names AND spellings (a collision silently overwrote the French row once),
 * and for the casing rule. The boot rule — seed only a registry with no rows,
 * by upsert — is pinned, because a registry with rows keeps what its admin
 * chose and two replicas may boot at once.
 */
jest.mock('../models/SweetnessTerm', () => {
  const Actual = jest.requireActual('../models/SweetnessTerm');
  Actual.estimatedDocumentCount = jest.fn();
  Actual.findOne = jest.fn();
  Actual.updateOne = jest.fn();
  return Actual;
});

const SweetnessTerm = require('../models/SweetnessTerm');
const { normalizeSweetnessTerm } = require('../utils/normalize');
const ops = require('./sweetnessOps');
const seed = require('../data/sweetness-terms.json');

const ID = (c) => c.repeat(24);
const ROWS = [
  { _id: ID('1'), name: 'trocken', scale: 'still', band: 'dry', country: null, synonyms: [] },
  { _id: ID('2'), name: 'Trocken', scale: 'sparkling', band: 'sec', country: null, synonyms: [] },
  { _id: ID('3'), name: 'süß', scale: 'still', band: 'sweet', country: null, synonyms: [] },
  { _id: ID('4'), name: 'Brut Nature', scale: 'sparkling', band: 'brut-nature', country: null, synonyms: ['Brut Natur'] },
  { _id: ID('5'), name: 'feinherb', scale: 'still', band: 'off-dry', regulated: false, country: null, synonyms: [] },
];

beforeEach(() => {
  jest.clearAllMocks();
  ops.primeSweetnessCache(ROWS);
});
afterEach(() => ops.primeSweetnessCache(null));

describe('scaleForType', () => {
  test('sparkling → the dosage scale, every other wine → still, fortified and non-wine → NO scale, no type → unknown', () => {
    expect(ops.scaleForType('sparkling')).toBe('sparkling');
    for (const t of ['red', 'white', 'rosé', 'dessert']) expect(ops.scaleForType(t)).toBe('still');
    expect(ops.scaleForType('fortified')).toBe(false);
    expect(ops.scaleForType('red', { nonWine: true })).toBe(false);
    expect(ops.scaleForType(undefined)).toBeNull();
  });
});

describe('resolveTerm', () => {
  test('the same word resolves by scale: trocken is dry on a still wine and sec on a Sekt', async () => {
    expect((await ops.resolveTerm('trocken', { scale: 'still' }))._id).toBe(ID('1'));
    expect((await ops.resolveTerm('TROCKEN', { scale: 'sparkling' })).band).toBe('sec');
  });

  test('an unknown type (null scale): a word on two scales is ambiguous, a word on one is not', async () => {
    expect(await ops.resolveTerm('trocken')).toBeNull();
    expect((await ops.resolveTerm('Brut Nature'))._id).toBe(ID('4'));
  });

  test('a fortified wine (no scale) resolves nothing — not even a word that exists on one scale only', async () => {
    expect(await ops.resolveTerm('Brut Nature', { scale: ops.scaleForType('fortified') })).toBeNull();
    expect(await ops.resolveTerm('süß', { scale: false })).toBeNull();
    const terms = await ops.loadTerms();
    expect(ops.resolveLoaded(terms, 'süß', { scale: false })).toBeNull();
  });

  test('ß resolves, as does an accepted spelling', async () => {
    expect((await ops.resolveTerm('SÜSS', { scale: 'still' }))._id).toBe(ID('3'));
    expect((await ops.resolveTerm('brut natur', { scale: 'sparkling' }))._id).toBe(ID('4'));
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

describe('the in-memory copy by id', () => {
  test('names a ref while warm, never reads, and says nothing when cold', () => {
    expect(ops.cachedTermName(ID('1'))).toBe('trocken');
    expect(ops.cachedTerm(ID('2'))).toMatchObject({ band: 'sec' });
    expect(ops.cachedTermName(ID('9'))).toBeNull();
    ops.primeSweetnessCache(null);
    expect(ops.cachedTermName(ID('1'))).toBeNull();
  });
});

describe('the API shape', () => {
  test('a populated term is { name, band, scale, regulated } — no country, no id; a customary word says so', () => {
    expect(ops.labelSweetnessOut({ labelSweetness: ROWS[0] })).toEqual({ name: 'trocken', band: 'dry', scale: 'still', regulated: true });
    expect(ops.labelSweetnessOut({ labelSweetness: { ...ROWS[4], country: 'c1' } })).toEqual({ name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false });
  });

  test('no term, an unresolvable ref and no wine are null; a ref the warm copy knows is the row', () => {
    expect(ops.labelSweetnessOut({ labelSweetness: null })).toBeNull();
    expect(ops.labelSweetnessOut({ labelSweetness: { _id: 'x' } })).toBeNull();
    expect(ops.labelSweetnessOut({ labelSweetness: ID('9') })).toBeNull();
    expect(ops.labelSweetnessOut(null)).toBeNull();
    expect(ops.labelSweetnessOut({ labelSweetness: ID('2') })).toEqual({ name: 'Trocken', band: 'sec', scale: 'sparkling', regulated: true });
  });

  test('a bare string is never a word', () => {
    expect(ops.labelSweetnessOut({ labelSweetness: 'trocken' })).toBeNull();
    expect(ops.wineDisplayName({ name: 'Riesling', labelSweetness: 'trocken' })).toBe('Riesling');
    expect(ops.labelSweetnessFields({ name: 'Riesling', labelSweetness: 'trocken' })).toEqual({});
  });

  test('the display name is the name as the label reads it, in the stored casing, never doubled', () => {
    expect(ops.wineDisplayName({ name: 'Riesling Kabinett', labelSweetness: ROWS[0] })).toBe('Riesling Kabinett trocken');
    expect(ops.wineDisplayName({ name: 'Riesling Kabinett Trocken', labelSweetness: ROWS[0] })).toBe('Riesling Kabinett Trocken');
    expect(ops.wineDisplayName({ name: 'Rosé', labelSweetness: ROWS[3] })).toBe('Rosé Brut Nature');
    expect(ops.wineDisplayName({ name: 'Brut Premier', labelSweetness: { name: 'Brut', scale: 'sparkling', band: 'brut' } })).toBe('Brut Premier');
    expect(ops.wineDisplayName({ name: 'Salmos', labelSweetness: null })).toBe('Salmos');
    expect(ops.wineDisplayName({ name: 'Salmos', labelSweetness: { _id: 'unpopulated' } })).toBe('Salmos');
    expect(ops.wineDisplayName(null)).toBe('');
  });

  test('the MCP fields are emitted only when the read loaded the field', () => {
    expect(ops.labelSweetnessFields({ name: 'Riesling' })).toEqual({});
    expect(ops.labelSweetnessFields({ name: 'Riesling', labelSweetness: null })).toEqual({ label_sweetness: null, display_name: 'Riesling' });
    expect(ops.labelSweetnessFields({ name: 'Riesling', labelSweetness: ROWS[0] })).toEqual({
      label_sweetness: { name: 'trocken', band: 'dry', scale: 'still', regulated: true }, display_name: 'Riesling trocken',
    });
    // An unpopulated ref: the warm copy names it; a cold copy says nothing rather than lying.
    expect(ops.labelSweetnessFields({ name: 'Sekt', labelSweetness: ID('2') }).display_name).toBe('Sekt Trocken');
    ops.primeSweetnessCache(null);
    expect(ops.labelSweetnessFields({ name: 'Sekt', labelSweetness: ID('2') })).toEqual({});
  });
});

describe('the seed', () => {
  const key = (s) => normalizeSweetnessTerm(s);

  test('every row has a scale the model knows and a band of that scale', () => {
    for (const r of seed) {
      expect(SweetnessTerm.SCALES).toContain(r.scale);
      expect(SweetnessTerm.BANDS[r.scale]).toContain(r.band);
    }
  });

  test('one word per scale across names AND spellings, through the real normaliser', () => {
    for (const scale of SweetnessTerm.SCALES) {
      const seen = new Map();
      for (const r of seed.filter((x) => x.scale === scale)) {
        for (const word of [r.name, ...(r.synonyms || [])]) {
          const k = key(word);
          expect(k).toBeTruthy();
          expect(seen.has(k) ? `${k}: "${seen.get(k)}" and "${r.name}" on the ${scale} scale` : null).toBeNull();
          seen.set(k, r.name);
        }
      }
    }
  });

  test('the casing rule: still-wine words lowercase, sparkling designations capitalised', () => {
    for (const r of seed) {
      const first = r.name[0];
      if (r.scale === 'still') expect(first).toBe(first.toLowerCase());
      else expect(first).toBe(first.toUpperCase());
    }
  });

  test('the German word on both scales; the Romanian demisec is a spelling of the French row; the customary words unregulated', () => {
    expect(seed.filter((r) => key(r.name) === 'trocken').map((r) => [r.scale, r.band]).sort()).toEqual([['sparkling', 'sec'], ['still', 'dry']]);
    // The Romanian word folds onto the French row's own key (the normaliser
    // joins the hyphen), so it needs no row and no spelling of its own.
    const demiSec = seed.find((r) => r.scale === 'still' && r.name === 'demi-sec');
    expect(key(demiSec.name)).toBe(key('demisec'));
    expect(seed.filter((r) => r.scale === 'still' && key(r.name) === 'demisec')).toHaveLength(1);
    for (const n of ['feinherb', 'fruchtsüß', 'off-dry', 'edelsüß', 'liquoreux']) expect(seed.find((r) => r.name === n).regulated).toBe(false);
    expect(seed.find((r) => r.name === 'Brut Nature').regulated).not.toBe(false);
    expect(seed).toHaveLength(74);
  });

  test('boot seeds a registry with no rows by upsert (two replicas write each row once) and leaves one with rows alone', async () => {
    SweetnessTerm.estimatedDocumentCount.mockResolvedValue(0);
    SweetnessTerm.findOne.mockResolvedValue(null);
    SweetnessTerm.updateOne.mockResolvedValue({ upsertedCount: 1 });
    expect(await ops.ensureSweetnessSeed()).toEqual({ seeded: true, created: seed.length, updated: 0 });
    const suess = SweetnessTerm.updateOne.mock.calls.find((c) => c[0].normalizedName === 'suss');
    expect(suess[0]).toEqual({ normalizedName: 'suss', scale: 'still' });
    expect(suess[1].$setOnInsert).toMatchObject({ name: 'süß', scale: 'still', band: 'sweet', createdByUser: false, country: null });
    expect(suess[2]).toEqual({ upsert: true });
    // The other replica got there first: nothing counted, nothing thrown.
    jest.clearAllMocks();
    SweetnessTerm.estimatedDocumentCount.mockResolvedValue(0);
    SweetnessTerm.findOne.mockResolvedValue(null);
    SweetnessTerm.updateOne.mockResolvedValue({ upsertedCount: 0 });
    expect(await ops.ensureSweetnessSeed()).toEqual({ seeded: true, created: 0, updated: 0 });

    jest.clearAllMocks();
    SweetnessTerm.estimatedDocumentCount.mockResolvedValue(seed.length);
    expect(await ops.ensureSweetnessSeed()).toEqual({ seeded: false });
    expect(SweetnessTerm.updateOne).not.toHaveBeenCalled();
  });
});

describe('the display name knows every spelling of the term', () => {
  const SEED = seed.map((r, i) => ({ _id: (i + 1).toString(16).padStart(24, '0'), country: null, ...r }));
  const apiRow = (name, scale) => {
    const r = SEED.find((x) => x.name === name && x.scale === scale);
    return { name: r.name, band: r.band, scale: r.scale, regulated: r.regulated !== false };
  };
  beforeEach(() => ops.primeSweetnessCache(SEED));

  test.each([
    ['Champagne Extra-Brut', 'Extra Brut', 'sparkling'],
    ['Vouvray Demi Sec', 'demi-sec', 'still'],
    ['Cava Brut Natur', 'Brut Nature', 'sparkling'],
    ['Riesling Medium', 'medium sweet', 'still'],
  ])('%s with the term %s (read in the API shape, no synonyms) is not doubled', (name, term, scale) => {
    const wine = { name, labelSweetness: apiRow(term, scale) };
    expect(ops.wineDisplayName(wine)).toBe(name);
    expect(ops.labelSweetnessFields(wine, { loaded: true }).display_name).toBe(name);
  });

  test('an admin term write expires the in-memory copy but keeps it: the synonyms are not forgotten before the reload', () => {
    const wine = { name: 'Cava Brut Natur', labelSweetness: apiRow('Brut Nature', 'sparkling') };
    ops.invalidateSweetnessCache();
    expect(ops.wineDisplayName(wine)).toBe('Cava Brut Natur');
    expect(ops.cachedTermName(SEED.find((r) => r.name === 'Brut Nature')._id)).toBe('Brut Nature');
  });

  test('the alias spellings the rule reads are carried too ("Suess" is süß)', () => {
    expect(ops.wineDisplayName({ name: 'Riesling Suess', labelSweetness: apiRow('süß', 'still') })).toBe('Riesling Suess');
    expect(ops.wineDisplayName({ name: 'Riesling Troken', labelSweetness: apiRow('trocken', 'still') })).toBe('Riesling Troken');
  });
});
