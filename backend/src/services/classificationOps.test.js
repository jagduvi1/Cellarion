/**
 * Classification taxonomy operations (support ticket 2026-10-29): splitting
 * a legacy string, stripping ride-along words, resolving names and synonyms
 * (the wine's country breaks ties between systems), the write rule
 * (assignClassification: strict for curators, lenient for members, a no-op
 * without a taxonomy), deriving the legacy string in kind order, and the
 * rule-based detection from a wine's name that only fires where the word is
 * a tier in that country. The taxonomy is primed in memory — no database.
 */
jest.mock('../models/Classification', () => ({ find: jest.fn(), findOne: jest.fn(), create: jest.fn(), estimatedDocumentCount: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn() }));

const ops = require('./classificationOps');

const DE = 'c'.repeat(23) + '1';
const AT = 'c'.repeat(23) + '2';
const PT = 'c'.repeat(23) + '3';
const ROWS = [
  { _id: 'a', name: 'Spätlese', kind: 'ripeness', country: null, synonyms: ['Spaetlese'] },
  { _id: 'b', name: 'VDP Grosse Lage', kind: 'vineyard_rank', country: DE, synonyms: ['VDP.Grosse Lage', 'Grosse Lage', 'Große Lage'] },
  { _id: 'k', name: 'Kabinett', kind: 'ripeness', country: null, synonyms: [] },
  { _id: 'de', name: 'VDP Erste Lage', kind: 'vineyard_rank', country: DE, synonyms: ['Erste Lage'] },
  { _id: 'at', name: 'ÖTW Erste Lage', kind: 'vineyard_rank', country: AT, synonyms: ['Erste Lage', '1ÖTW'] },
  { _id: 'x', name: 'Reserva', kind: 'ageing', country: null, synonyms: [] },
  { _id: 'pt', name: 'Reserve Port', kind: 'ageing', country: PT, synonyms: ['Reserva'] },
  { _id: 'r', name: 'Reserve', kind: 'other', country: null, synonyms: [] },
];

afterEach(() => ops.primeClassificationCache(null));

describe('splitClassificationString', () => {
  test('splits on the separators imports used and drops repeats and blanks', () => {
    expect(ops.splitClassificationString('Spätlese, VDP.Grosse Lage')).toEqual(['Spätlese', 'VDP.Grosse Lage']);
    expect(ops.splitClassificationString('Kabinett / Erste Lage')).toEqual(['Kabinett', 'Erste Lage']);
    expect(ops.splitClassificationString('Riserva and Riserva')).toEqual(['Riserva']);
    expect(ops.splitClassificationString('  ')).toEqual([]);
    expect(ops.splitClassificationString(null)).toEqual([]);
  });

  test('parentheses and a spaced dash split; a hyphenated name stays whole', () => {
    expect(ops.splitClassificationString('VDP.Grosse Lage (Grosses Gewächs)')).toEqual(['VDP.Grosse Lage', 'Grosses Gewächs']);
    expect(ops.splitClassificationString('Estate Grown - Single Vineyard')).toEqual(['Estate Grown', 'Single Vineyard']);
    expect(ops.splitClassificationString('Qualitätswein · Hochgewächs')).toEqual(['Qualitätswein', 'Hochgewächs']);
    expect(ops.splitClassificationString('Saint-Émilion Grand Cru Classé')).toEqual(['Saint-Émilion Grand Cru Classé']);
  });
});

describe('stripNoise', () => {
  test('removes the words that ride along with a tier and reports an empty value for nothing else', () => {
    expect(ops.stripNoise('Kabinett trocken')).toBe('kabinett');
    expect(ops.stripNoise('Spätlese Trocken')).toBe('spatlese');
    expect(ops.stripNoise('Premier Cru Classé 1855')).toBe('premier cru classe');
    expect(ops.stripNoise('Deutscher Qualitätswein')).toBe('');
    expect(ops.stripNoise('trocken')).toBe('');
    expect(ops.stripNoise('Gran Reserva')).toBe('gran reserva');
  });
});

describe('resolveClassifications', () => {
  beforeEach(() => ops.primeClassificationCache(ROWS));

  test('matches names and synonyms without case or accents, keeps the asked order, reports the rest', async () => {
    const r = await ops.resolveClassifications(['Grosse Lage', 'SPATLESE', 'Brut', 'Spaetlese']);
    expect(r.rows.map((x) => x.name)).toEqual(['VDP Grosse Lage', 'Spätlese']);
    expect(r.unresolved).toEqual(['Brut']);
    expect(r.dropped).toEqual([]);
  });

  test('a ride-along word is stripped before the lookup, and a value of nothing else is dropped, not unresolved', async () => {
    const r = await ops.resolveClassifications(['Kabinett trocken', 'trocken', 'Brut']);
    expect(r.rows.map((x) => x.name)).toEqual(['Kabinett']);
    expect(r.dropped).toEqual(['trocken']);
    expect(r.unresolved).toEqual(['Brut']);
  });

  test('a word shared by two systems resolves to the row of the given country, else the country-less row', async () => {
    expect((await ops.resolveClassifications(['Erste Lage'], { countryId: AT })).rows[0].name).toBe('ÖTW Erste Lage');
    expect((await ops.resolveClassifications(['Erste Lage'], { countryId: DE })).rows[0].name).toBe('VDP Erste Lage');
    expect((await ops.resolveClassifications(['Reserva'], { countryId: 'e'.repeat(24) })).rows[0].name).toBe('Reserva');
    expect((await ops.resolveClassifications(['Reserva'], { countryId: PT })).rows[0].name).toBe('Reserve Port');
    expect((await ops.resolveClassifications(['Reserva'])).rows[0].name).toBe('Reserva');
  });

  test('nothing asked, nothing resolved', async () => {
    expect(await ops.resolveClassifications([])).toEqual({ rows: [], unresolved: [], dropped: [] });
  });

  test('without a taxonomy (no connection, no seed) every name is unresolved', async () => {
    ops.primeClassificationCache(null);
    const r = await ops.resolveClassifications(['Kabinett']);
    expect(r).toEqual({ rows: [], unresolved: ['Kabinett'], dropped: [] });
  });
});

describe('assignClassification — the write rule', () => {
  beforeEach(() => ops.primeClassificationCache(ROWS));

  test('a typed string resolves to rows and the stored string follows them in kind order', async () => {
    const wine = {};
    const r = await ops.assignClassification(wine, { classification: 'Spatlese, VDP.Grosse Lage', countryId: DE });
    expect(r.ok).toBe(true);
    expect(wine.classifications).toEqual(['b', 'a']);
    expect(wine.classification).toBe('VDP Grosse Lage, Spätlese');
  });

  test('lenient: a word the taxonomy lacks is dropped beside a tier, kept as the string when alone', async () => {
    const beside = {};
    const r1 = await ops.assignClassification(beside, { classification: 'Kabinett trocken, Vin de France' });
    expect(r1).toMatchObject({ ok: true, unresolved: ['Vin de France'] });
    expect(beside).toEqual({ classifications: ['k'], classification: 'Kabinett' });

    const alone = {};
    await ops.assignClassification(alone, { classification: 'Vin de France' });
    expect(alone).toEqual({ classifications: [], classification: 'Vin de France' });
  });

  test('strict: a word the taxonomy lacks is refused with the known tiers, and nothing is written', async () => {
    const wine = { classification: 'before', classifications: ['k'] };
    const r = await ops.assignClassification(wine, { classification: 'Kabinett, Vin de France', countryId: DE, strict: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_input');
    expect(r.message).toMatch(/"Vin de France" is not in the registry/);
    expect(r.message).toMatch(/Kabinett/);
    expect(r.message).toMatch(/VDP Grosse Lage/);
    expect(r.message).not.toMatch(/ÖTW/); // another country's tier is not offered
    expect(wine).toEqual({ classification: 'before', classifications: ['k'] });
  });

  test('rows a picker chose: ids or names; an unknown id is refused when strict; [] clears', async () => {
    const wine = {};
    expect((await ops.assignClassification(wine, { classifications: ['a', 'Grosse Lage'], countryId: DE })).ok).toBe(true);
    expect(wine).toEqual({ classifications: ['b', 'a'], classification: 'VDP Grosse Lage, Spätlese' });
    expect((await ops.assignClassification({}, { classifications: ['nope'], strict: true })).ok).toBe(false);
    await ops.assignClassification(wine, { classifications: [] });
    expect(wine).toEqual({ classifications: [], classification: null });
  });

  test("'' and null clear; a regulatory mark alone clears; undefined leaves the wine alone", async () => {
    const wine = { classification: 'Kabinett', classifications: ['k'] };
    await ops.assignClassification(wine, { classification: '' });
    expect(wine).toEqual({ classifications: [], classification: null });
    await ops.assignClassification(wine, { classification: 'DOCG' });
    expect(wine).toEqual({ classifications: [], classification: null });
    const untouched = { classification: 'Kabinett' };
    expect(await ops.assignClassification(untouched, {})).toMatchObject({ ok: true, changed: false });
    expect(untouched).toEqual({ classification: 'Kabinett' });
  });

  test('the country comes from the wine itself when not given, populated or not', async () => {
    const populated = { country: { _id: AT, name: 'Austria' } };
    await ops.assignClassification(populated, { classification: 'Erste Lage' });
    expect(populated.classification).toBe('ÖTW Erste Lage');
    const bare = { country: DE };
    await ops.assignClassification(bare, { classification: 'Erste Lage' });
    expect(bare.classification).toBe('VDP Erste Lage');
  });

  test('without a taxonomy every path keeps the cleaned string, strict included', async () => {
    ops.primeClassificationCache(null);
    const wine = {};
    const r = await ops.assignClassification(wine, { classification: 'Kabinett  trocken', strict: true });
    expect(r.ok).toBe(true);
    expect(wine).toEqual({ classifications: [], classification: 'Kabinett trocken' });
  });
});

describe('classificationString', () => {
  test('joins names in kind order: vineyard rank, ripeness, ageing, other', () => {
    expect(ops.classificationString([
      { name: 'Spätlese', kind: 'ripeness' }, { name: 'VDP Grosse Lage', kind: 'vineyard_rank' }, { name: 'Reserve', kind: 'other' },
    ])).toBe('VDP Grosse Lage, Spätlese, Reserve');
    expect(ops.classificationString([])).toBeNull();
  });
});

describe('classificationsOut', () => {
  test('populated rows become [{ name, kind }]; ids alone become []', () => {
    expect(ops.classificationsOut({ classifications: [{ _id: 'a', name: 'Spätlese', kind: 'ripeness' }, 'b'] })).toEqual([{ name: 'Spätlese', kind: 'ripeness' }]);
    expect(ops.classificationsOut({ classifications: ['a'] })).toEqual([]);
    expect(ops.classificationsOut({})).toEqual([]);
  });
});

describe('detectFromName — a tier the name states, where the word is a tier', () => {
  const d = (name, countryName, extra = {}) => ops.detectFromName({ name, countryName, ...extra });

  test('German and Austrian Prädikat, Wachau and ÖTW tiers, VDP terms, Hochgewächs', () => {
    expect(d('Wehlener Sonnenuhr Riesling Spätlese', 'Germany')).toEqual(['Spätlese']);
    expect(d('Scharzhofberger Riesling Auslese GG', 'Germany')).toEqual(['Auslese', 'Grosses Gewächs']);
    expect(d('Riesling Trockenbeerenauslese', 'Germany')).toEqual(['Trockenbeerenauslese']);
    expect(d('Riesling Hochgewächs', 'Germany')).toEqual(['Hochgewächs']);
    expect(d('Grüner Veltliner Smaragd Loibenberg', 'Austria')).toEqual(['Smaragd']);
    expect(d('Riesling Spätlese', 'Austria')).toEqual(['Spätlese']);
    expect(d('Ruster Ausbruch', 'Austria')).toEqual(['Ausbruch']);
    expect(d('Ried Heiligenstein Erste Lage', 'Austria')).toEqual(['ÖTW Erste Lage']);
    expect(d('Ried Heiligenstein 1ÖTW', 'Austria')).toEqual(['ÖTW Erste Lage']);
    expect(d('Ried Heiligenstein Erste Lage', 'Germany')).toEqual([]);
  });

  test('Italy, Spain and Portugal ageing tiers; the longer phrase wins', () => {
    expect(d('Barolo Riserva', 'Italy')).toEqual(['Riserva']);
    expect(d('Chianti Classico Gran Selezione', 'Italy')).toEqual(['Gran Selezione']);
    expect(d('Rioja Gran Reserva', 'Spain')).toEqual(['Gran Reserva']);
    expect(d('Rioja Crianza', 'Spain')).toEqual(['Crianza']);
    expect(d('Ribera del Duero Roble', 'Spain')).toEqual(['Roble']);
    expect(d('Douro Reserva', 'Portugal')).toEqual(['Reserva']);
  });

  test('Spanish vineyard ranks, Tokaji puttonyos, Alsace late harvest', () => {
    expect(d('Les Terrasses Vi de Vila Gratallops', 'Spain')).toEqual(['Vi de Vila']);
    expect(d('Finca X Viñedo Singular', 'Spain')).toEqual(['Viñedo Singular']);
    expect(d('Tokaji Aszú 6 Puttonyos', 'Hungary')).toEqual(['6 Puttonyos']);
    expect(d('Gewurztraminer Vendanges Tardives', 'France', { regionName: 'Alsace' })).toEqual(['Vendange Tardive']);
    expect(d('Gewurztraminer Vendanges Tardives', 'France', { regionName: 'Loire' })).toEqual([]);
  });

  test('Port and Madeira categories for a fortified wine or a wine named as Port; Douro still wines keep Reserva', () => {
    expect(d('Vintage Port', 'Portugal', { type: 'fortified' })).toEqual(['Vintage Port']);
    expect(d('LBV 2017', 'Portugal', { type: 'fortified' })).toEqual(['Late Bottled Vintage']);
    expect(d('Late Bottled Vintage Port', 'Portugal', { type: 'fortified' })).toEqual(['Late Bottled Vintage']);
    expect(d('20 Year Old Tawny', 'Portugal', { type: 'fortified' })).toEqual(['20 Years Old', 'Tawny Port']);
    expect(d('Tawny Reserve', 'Portugal', { type: 'fortified' })).toEqual(['Reserve Port']);
    expect(d('Porto Reserva', 'Portugal', { type: 'red' })).toEqual(['Reserve Port']);
    expect(d('Madeira Colheita', 'Portugal', { type: 'fortified' })).toEqual(['Colheita']);
    expect(d('Quinta X Reserva', 'Portugal', { type: 'red' })).toEqual(['Reserva']);
    expect(d('Tawny', 'Spain', { type: 'fortified' })).toEqual([]);
  });

  test('France only inside Bordeaux (classed growths) and Champagne (village ranking)', () => {
    expect(d('Château X Grand Cru Classé', 'France', { regionName: 'Bordeaux' })).toEqual(['Grand Cru Classé']);
    expect(d('Château Y Cru Bourgeois', 'France', { regionName: 'Bordeaux' })).toEqual(['Cru Bourgeois']);
    expect(d("Château d'Yquem Premier Cru Supérieur", 'France', { regionName: 'Bordeaux' })).toEqual(['Premier Cru Supérieur']);
    expect(d('Blanc de Blancs Grand Cru', 'France', { appellation: 'Champagne' })).toEqual(['Grand Cru']);
    // Burgundy and Alsace keep the words in the appellation: nothing detected.
    expect(d('Chablis Premier Cru Montée de Tonnerre', 'France', { regionName: 'Burgundy', appellation: 'Chablis Premier Cru' })).toEqual([]);
    expect(d('Riesling Grand Cru Schlossberg', 'France', { regionName: 'Alsace', appellation: 'Alsace Grand Cru' })).toEqual([]);
  });

  test('with the rest: what remains of an appellation once its tier is read out', () => {
    expect(ops.detectFromName({ name: 'Chianti Classico Riserva', countryName: 'Italy' }, { withRest: true })).toEqual({ names: ['Riserva'], rest: 'Chianti Classico' });
    expect(ops.detectFromName({ name: 'Großes Gewächs', countryName: 'Germany' }, { withRest: true })).toEqual({ names: ['Grosses Gewächs'], rest: '' });
    expect(ops.detectFromName({ name: 'Chablis Premier Cru', countryName: 'France', regionName: 'Burgundy', appellation: 'Chablis Premier Cru' }, { withRest: true })).toEqual({ names: [], rest: 'Chablis Premier Cru' });
  });

  test('never outside the word\'s own country, never from a fragment, never without a country', () => {
    expect(d('Reserva Cabernet Sauvignon', 'Chile')).toEqual([]);
    expect(d('Kabinettstück', 'Germany')).toEqual([]);
    expect(d('Barolo Riserva', null)).toEqual([]);
  });
});
