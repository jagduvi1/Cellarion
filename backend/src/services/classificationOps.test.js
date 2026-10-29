/**
 * Classification taxonomy operations (support ticket 2026-10-29): splitting
 * a legacy string, stripping ride-along words, resolving names and synonyms
 * (the wine's country breaks ties between systems), deriving the legacy
 * string in kind order, and the rule-based detection from a wine's name that
 * only fires where the word is a tier in that country.
 */
jest.mock('../models/Classification', () => ({ find: jest.fn(), findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn() }));

const Classification = require('../models/Classification');
const ops = require('./classificationOps');

const lean = (rows) => ({ lean: async () => rows });

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
    expect(ops.stripNoise('Premier Cru Classé (1855)'.replace(/[()]/g, ''))).toBe('premier cru classe');
    expect(ops.stripNoise('Deutscher Qualitätswein')).toBe('');
    expect(ops.stripNoise('trocken')).toBe('');
    expect(ops.stripNoise('Gran Reserva')).toBe('gran reserva');
  });
});

describe('resolveClassifications', () => {
  test('matches names and synonyms without case or accents, keeps the asked order, reports the rest', async () => {
    Classification.find.mockReturnValue(lean([
      { _id: 'a', name: 'Spätlese', kind: 'ripeness', normalizedName: 'spatlese', normalizedSynonyms: ['spaetlese'] },
      { _id: 'b', name: 'VDP Grosse Lage', kind: 'vineyard_rank', normalizedName: 'vdp grosse lage', normalizedSynonyms: ['vdpgrosse lage', 'grosse lage', 'grose lage'] },
    ]));
    const r = await ops.resolveClassifications(['Grosse Lage', 'SPATLESE', 'Brut', 'Spaetlese']);
    expect(r.rows.map((x) => x.name)).toEqual(['VDP Grosse Lage', 'Spätlese']);
    expect(r.unresolved).toEqual(['Brut']);
    expect(r.dropped).toEqual([]);
  });

  test('a ride-along word is stripped before the lookup, and a value of nothing else is dropped, not unresolved', async () => {
    Classification.find.mockReturnValue(lean([
      { _id: 'k', name: 'Kabinett', kind: 'ripeness', normalizedName: 'kabinett', normalizedSynonyms: [] },
    ]));
    const r = await ops.resolveClassifications(['Kabinett trocken', 'trocken', 'Brut']);
    expect(r.rows.map((x) => x.name)).toEqual(['Kabinett']);
    expect(r.dropped).toEqual(['trocken']);
    expect(r.unresolved).toEqual(['Brut']);
  });

  test('a word shared by two systems resolves to the row of the given country, else the country-less row', async () => {
    const rows = [
      { _id: 'de', name: 'VDP Erste Lage', kind: 'vineyard_rank', country: 'DE', normalizedName: 'vdp erste lage', normalizedSynonyms: ['erste lage'] },
      { _id: 'at', name: 'ÖTW Erste Lage', kind: 'vineyard_rank', country: 'AT', normalizedName: 'otw erste lage', normalizedSynonyms: ['erste lage', '1otw'] },
      { _id: 'x', name: 'Reserva', kind: 'ageing', country: null, normalizedName: 'reserva', normalizedSynonyms: [] },
      { _id: 'pt', name: 'Reserve Port', kind: 'ageing', country: 'PT', normalizedName: 'reserve port', normalizedSynonyms: ['reserva'] },
    ];
    Classification.find.mockReturnValue(lean(rows));
    expect((await ops.resolveClassifications(['Erste Lage'], { countryId: 'AT' })).rows[0].name).toBe('ÖTW Erste Lage');
    expect((await ops.resolveClassifications(['Erste Lage'], { countryId: 'DE' })).rows[0].name).toBe('VDP Erste Lage');
    expect((await ops.resolveClassifications(['Reserva'], { countryId: 'ES' })).rows[0].name).toBe('Reserva');
    expect((await ops.resolveClassifications(['Reserva'])).rows[0].name).toBe('Reserva');
  });

  test('nothing asked, nothing queried', async () => {
    Classification.find.mockClear();
    expect(await ops.resolveClassifications([])).toEqual({ rows: [], unresolved: [], dropped: [] });
    expect(Classification.find).not.toHaveBeenCalled();
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

describe('detectFromName — a tier the name states, where the word is a tier', () => {
  const d = (name, countryName, extra = {}) => ops.detectFromName({ name, countryName, ...extra });

  test('German and Austrian Prädikat, Wachau and ÖTW tiers, VDP terms, Hochgewächs', () => {
    expect(d('Wehlener Sonnenuhr Riesling Spätlese', 'Germany')).toEqual(['Spätlese']);
    expect(d('Scharzhofberger Riesling Auslese GG', 'Germany')).toEqual(['Auslese', 'Grosses Gewächs']);
    expect(d('Riesling Trockenbeerenauslese', 'Germany')).toEqual(['Trockenbeerenauslese']);
    expect(d('Riesling Hochgewächs', 'Germany')).toEqual(['Hochgewächs']);
    expect(d('Grüner Veltliner Smaragd Loibenberg', 'Austria')).toEqual(['Smaragd']);
    expect(d('Riesling Spätlese', 'Austria')).toEqual(['Spätlese']);
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

  test('Spanish vineyard ranks and Tokaji puttonyos', () => {
    expect(d('Les Terrasses Vi de Vila Gratallops', 'Spain')).toEqual(['Vi de Vila']);
    expect(d('Finca X Viñedo Singular', 'Spain')).toEqual(['Viñedo Singular']);
    expect(d('Tokaji Aszú 6 Puttonyos', 'Hungary')).toEqual(['6 Puttonyos']);
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

  test('never outside the word\'s own country, never from a fragment, never without a country', () => {
    expect(d('Reserva Cabernet Sauvignon', 'Chile')).toEqual([]);
    expect(d('Kabinettstück', 'Germany')).toEqual([]);
    expect(d('Barolo Riserva', null)).toEqual([]);
  });
});
