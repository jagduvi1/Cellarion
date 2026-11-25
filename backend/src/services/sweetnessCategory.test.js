/**
 * The sweetness category (services/sweetnessCategory): dry, off-dry,
 * medium-sweet or sweet, and what it rests on.
 *
 * WHY THIS TEST EXISTS:
 * The category is what a member filters a cellar by, across still and
 * sparkling wines and every country's words. It is worked out, never stored,
 * so the order of its sources IS the feature: the label's term first, then
 * the word the name still carries, then the term the wine is known by, then
 * the tiers that settle it (sweet by law, Grosses Gewächs), then the type
 * "dessert". And what it must never do is guess: a Kabinett without a term
 * is not stated, a word in the middle of a still wine's name is no statement
 * ("Dolce Vita" is not a sweet wine), a place word is no sweetness word, a
 * fortified wine has no scale. A reading that drifts here puts wines under
 * the wrong filter for everyone. Pinned against the real seed table, on plain
 * wine objects.
 */
const ops = require('./sweetnessOps');
const SweetnessTerm = require('../models/SweetnessTerm');
const {
  CATEGORIES, BASES, NOT_STATED, FILTER_VALUES, BAND_CATEGORY,
  sweetnessCategoryOf, parseSweetnessFilter, sweetnessFilterValue, sweetnessQueryValue,
} = require('./sweetnessCategory');
const seed = require('../data/sweetness-terms.json');

const hex = (n) => n.toString(16).padStart(24, '0');
const ROWS = seed.map((r, i) => ({ _id: hex(i + 1), country: null, ...r }));
const row = (name, scale = 'still') => ROWS.find((r) => r.name === name && r.scale === scale);
const id = (name, scale) => row(name, scale)._id;
let terms;

beforeEach(async () => { ops.primeSweetnessCache(ROWS); terms = await ops.loadTerms(); });
afterEach(() => ops.primeSweetnessCache(null));

const wine = (over = {}) => ({ name: 'Riesling', producer: 'Weingut Beispiel', type: 'white', labelSweetness: null, sweetnessStyle: null, ...over });
const read = (over) => sweetnessCategoryOf(wine(over), terms);
const style = (name, over = {}) => ({ term: id(name), source: 'trade', url: 'https://x.example/', ...over });

describe('the scale', () => {
  test('every band of both scales folds onto one of the four categories', () => {
    expect(Object.keys(BAND_CATEGORY).sort()).toEqual([...SweetnessTerm.ALL_BANDS].sort());
    expect(new Set(Object.values(BAND_CATEGORY))).toEqual(new Set(CATEGORIES));
    expect(CATEGORIES).toEqual(SweetnessTerm.BANDS.still);
  });

  test('the sparkling bands: brut nature, extra brut and brut are dry; extra dry and sec off-dry; demi-sec medium-sweet; doux sweet', () => {
    const sparkling = (name) => read({ type: 'sparkling', name: 'Cuvée', labelSweetness: id(name, 'sparkling') }).category;
    expect(['Brut Nature', 'Extra Brut', 'Brut'].map(sparkling)).toEqual(['dry', 'dry', 'dry']);
    expect(['Extra Dry', 'Sec'].map(sparkling)).toEqual(['off-dry', 'off-dry']);
    expect(sparkling('Demi-Sec')).toBe('medium-sweet');
    expect(sparkling('Doux')).toBe('sweet');
  });
});

describe('what the category rests on, first match first', () => {
  test('the label\'s term, as an id or as a populated row without one', () => {
    expect(read({ labelSweetness: id('halbtrocken') })).toEqual({ category: 'off-dry', basis: 'label' });
    expect(read({ labelSweetness: { name: 'trocken', band: 'dry', scale: 'still', regulated: true } })).toEqual({ category: 'dry', basis: 'label' });
  });

  test('the word that ends a still wine\'s name; a sparkling term anywhere in the name', () => {
    expect(read({ name: 'Riesling Kabinett trocken' })).toEqual({ category: 'dry', basis: 'name' });
    expect(read({ name: 'Riesling feinherb' })).toEqual({ category: 'off-dry', basis: 'name' });
    expect(read({ type: 'sparkling', name: 'Brut Réserve' })).toEqual({ category: 'dry', basis: 'name' });
    expect(read({ type: 'sparkling', name: 'Cuvée Demi-Sec Rosé' })).toEqual({ category: 'medium-sweet', basis: 'name' });
  });

  test('the term the wine is known by, stored or as a read sends it', () => {
    expect(read({ sweetnessStyle: style('fruchtsüß') })).toEqual({ category: 'medium-sweet', basis: 'style' });
    expect(read({ sweetnessStyle: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: 'https://x.example/' } }))
      .toEqual({ category: 'off-dry', basis: 'style' });
  });

  test('a tier that is sweet by law, in the name or in the classification', () => {
    expect(read({ name: 'Riesling Beerenauslese' })).toEqual({ category: 'sweet', basis: 'tier' });
    expect(read({ classification: 'Trockenbeerenauslese' })).toEqual({ category: 'sweet', basis: 'tier' });
    expect(read({ classification: 'VDP.Grosse Lage, Eiswein' })).toEqual({ category: 'sweet', basis: 'tier' });
  });

  test('a Grosses Gewächs is dry: written out, as GG, as the VDP writes it, in the classification or the name', () => {
    expect(read({ classification: 'VDP Grosse Lage, Grosses Gewächs' })).toEqual({ category: 'dry', basis: 'tier' });
    expect(read({ classification: 'VDP.Großes Gewächs' })).toEqual({ category: 'dry', basis: 'tier' });
    expect(read({ name: 'Saarfeilser GG' })).toEqual({ category: 'dry', basis: 'tier' });
    // Letters inside a word are no GG.
    expect(read({ name: 'EGGO Malbec' })).toBeNull();
  });

  test('a wine typed dessert is sweet when nothing else says so', () => {
    expect(read({ type: 'dessert', name: 'Sauternes' })).toEqual({ category: 'sweet', basis: 'type' });
  });

  test('the order holds: label over name, name over style, style over tier, tier over type', () => {
    expect(read({ name: 'Riesling trocken', labelSweetness: id('halbtrocken') })).toEqual({ category: 'off-dry', basis: 'label' });
    expect(read({ name: 'Riesling trocken', sweetnessStyle: style('feinherb') })).toEqual({ category: 'dry', basis: 'name' });
    expect(read({ name: 'Riesling Beerenauslese', sweetnessStyle: style('edelsüß') }).basis).toBe('style');
    expect(read({ type: 'dessert', name: 'Riesling Eiswein' })).toEqual({ category: 'sweet', basis: 'tier' });
    expect(read({ type: 'dessert', name: 'Auslese', labelSweetness: id('halbtrocken') })).toEqual({ category: 'off-dry', basis: 'label' });
  });

  test('every basis the reader can answer is one of the documented ones', () => {
    const seen = new Set([
      read({ labelSweetness: id('trocken') }), read({ name: 'Riesling trocken' }),
      read({ sweetnessStyle: style('feinherb') }), read({ name: 'Eiswein' }), read({ type: 'dessert' }),
    ].map((r) => r.basis));
    expect([...seen].sort()).toEqual([...BASES].sort());
  });
});

describe('the name is read as the label sweetness write rule reads it', () => {
  test('a still-wine word that does not end the name is no statement', () => {
    for (const [name, type] of [
      ['Dolce Vita', 'red'], ['La Dolce Vita Rosso', 'red'], ['Doux Reve Blanc', 'white'],
      ['Arroyo Seco Chardonnay', 'white'], ['Monte Seco Tinto', 'red'], ['Medium Plus Chardonnay', 'white'],
      ['Riesling trocken Alte Reben', 'white'],
    ]) expect([name, read({ name, type })]).toEqual([name, null]);
  });

  test('a word that is not the wine\'s own statement: an English word, a place, a word inside another', () => {
    expect(read({ name: 'Dry Creek Zinfandel', type: 'red' })).toBeNull();
    expect(read({ name: 'Zinfandel Dry', type: 'red' })).toBeNull();
    expect(read({ name: 'Chardonnay Seco', appellation: 'Arroyo Seco' })).toBeNull();
    expect(read({ name: 'Trockenbeerenauslese', type: 'dessert' })).toEqual({ category: 'sweet', basis: 'tier' });
  });

  test('a name that states two terms states none; what is weaker may still speak', () => {
    expect(read({ name: 'Riesling trocken halbtrocken' })).toBeNull();
    expect(read({ type: 'sparkling', name: 'Brut de Brut' })).toBeNull();
    expect(read({ type: 'sparkling', name: 'Brut Demi-Sec' })).toBeNull();
    const doux = { term: id('Doux', 'sparkling'), source: 'producer', url: 'https://x.example/' };
    expect(read({ type: 'sparkling', name: 'Cuvée Brut Rosé Sec', sweetnessStyle: doux })).toEqual({ category: 'sweet', basis: 'style' });
  });

  test('a dry-side word in the name of a wine whose tier is sweet by law states nothing: the tier speaks', () => {
    for (const name of [
      'Riesling Trocken Beerenauslese', 'Riesling Trocken-Beerenauslese',
      'Riesling Beerenauslese trocken', 'Riesling Eiswein feinherb',
    ]) expect([name, read({ name })]).toEqual([name, { category: 'sweet', basis: 'tier' }]);
    expect(read({ name: 'Riesling trocken', classification: 'Beerenauslese' })).toEqual({ category: 'sweet', basis: 'tier' });
    // A sweet-side word agrees with the tier, and is the nearer statement.
    expect(read({ name: 'Riesling Beerenauslese edelsüß' })).toEqual({ category: 'sweet', basis: 'name' });
  });

  test('a name marked as carrying the word on purpose (sweetnessInName) is not read', () => {
    expect(read({ type: 'sparkling', name: 'Brut Premier', sweetnessInName: true })).toBeNull();
    expect(read({ type: 'sparkling', name: 'Brut Premier', sweetnessInName: true, labelSweetness: id('Brut', 'sparkling') }))
      .toEqual({ category: 'dry', basis: 'label' });
    expect(read({ type: 'sparkling', name: 'Brut Premier' })).toEqual({ category: 'dry', basis: 'name' });
  });
});

describe('what is never guessed', () => {
  test('a Kabinett, Spätlese or Auslese without a term is not stated', () => {
    for (const name of ['Riesling Kabinett', 'Riesling Spätlese', 'Riesling Auslese']) expect(read({ name })).toBeNull();
    expect(read({ classification: 'Spätlese' })).toBeNull();
  });

  test('a fortified wine and a drink that is not wine have no scale, whatever else is on the record', () => {
    expect(read({ type: 'fortified', name: 'Tawny Port' })).toBeNull();
    expect(read({ nonWine: true, name: 'Cidre Brut' })).toBeNull();
    expect(read({ type: 'fortified', labelSweetness: id('trocken') })).toBeNull();
  });

  test('a wine with no type is read by its label term or style, never by a word in its name', () => {
    expect(read({ type: null, name: 'Riesling trocken' })).toBeNull();
    expect(read({ type: null, name: 'Riesling', labelSweetness: id('trocken') })).toEqual({ category: 'dry', basis: 'label' });
    expect(read({ type: null, name: 'Riesling', sweetnessStyle: style('feinherb') })).toEqual({ category: 'off-dry', basis: 'style' });
  });

  test('without a wine or a table there is no reading', () => {
    expect(sweetnessCategoryOf(null, terms)).toBeNull();
    expect(sweetnessCategoryOf(wine(), null)).toBeNull();
  });
});

describe('a record that does not hold together', () => {
  test('a label term of the other scale is read as the same word on the wine\'s own scale', () => {
    // A Sekt that still holds the still-wine "trocken": on the sparkling scale that word is the sec band.
    expect(row('Trocken', 'sparkling')).toMatchObject({ band: 'sec' });
    expect(read({ type: 'sparkling', name: 'Riesling Sekt', labelSweetness: id('trocken') })).toEqual({ category: 'off-dry', basis: 'label' });
  });

  test('a term the wine\'s scale has no word for states nothing, and what follows speaks', () => {
    expect(read({ type: 'white', name: 'Riesling', labelSweetness: id('Brut Nature', 'sparkling') })).toBeNull();
    expect(read({ type: 'white', name: 'Riesling feinherb', labelSweetness: id('Brut Nature', 'sparkling') })).toEqual({ category: 'off-dry', basis: 'name' });
  });

  test('a term row that is gone, or a band the fold does not know, states nothing and does not stop the reading', () => {
    expect(read({ name: 'Riesling trocken', labelSweetness: hex(9999) })).toEqual({ category: 'dry', basis: 'name' });
    for (const band of ['constructor', 'toString', 'bone-dry']) {
      expect(read({ name: 'Riesling trocken', labelSweetness: { name: 'x', band, scale: 'still' } })).toEqual({ category: 'dry', basis: 'name' });
      expect(read({ name: 'Riesling', labelSweetness: { name: 'x', band, scale: 'still' } })).toBeNull();
    }
  });

  test('a style no read would send is no basis: a source or a link that fails the rules, a term that is gone', () => {
    expect(read({ sweetnessStyle: style('fruchtsüß', { source: 'critic' }) })).toBeNull();
    expect(read({ sweetnessStyle: style('fruchtsüß', { url: 'not a link' }) })).toBeNull();
    expect(read({ sweetnessStyle: { term: hex(9999), source: 'trade', url: 'https://x.example/' } })).toBeNull();
    expect(read({ sweetnessStyle: { name: 'feinherb', band: 'off-dry', scale: 'still', regulated: false, source: 'trade', sourceUrl: 'ftp://x' } })).toBeNull();
  });
});

describe('the filter', () => {
  test('a request names categories, comma-separated, and "not-stated" for the wines with none', () => {
    expect([...parseSweetnessFilter('dry, Off-Dry')]).toEqual(['dry', 'off-dry']);
    expect([...parseSweetnessFilter('not-stated')]).toEqual([NOT_STATED]);
    expect(FILTER_VALUES).toEqual([...CATEGORIES, NOT_STATED]);
  });

  test('words that are no category are dropped; a value of such words alone finds nothing', () => {
    expect([...parseSweetnessFilter('dry,brut,')]).toEqual(['dry']);
    expect(parseSweetnessFilter('brut').size).toBe(0);
  });

  test('no value, or one that is not plain text, is no filter', () => {
    expect(parseSweetnessFilter('')).toBeNull();
    expect(parseSweetnessFilter('  ')).toBeNull();
    expect(parseSweetnessFilter(undefined)).toBeNull();
    expect(parseSweetnessFilter(['dry'])).toBeNull();
    expect(parseSweetnessFilter({ $ne: 'dry' })).toBeNull();
  });

  test('a query carries one value, or the same key repeated; anything else is no value', () => {
    expect(sweetnessQueryValue('dry,sweet')).toBe('dry,sweet');
    expect(sweetnessQueryValue(['dry', 'sweet'])).toBe('dry,sweet');
    expect(sweetnessQueryValue([])).toBeUndefined();
    expect(sweetnessQueryValue(['dry', { $ne: 1 }])).toBeUndefined();
    expect(sweetnessQueryValue({ $ne: 'dry' })).toBeUndefined();
    expect(sweetnessQueryValue(undefined)).toBeUndefined();
  });

  test('a wine is found by its category; one that could state a category and does not, by "not-stated"', () => {
    expect(sweetnessFilterValue(wine({ name: 'Riesling trocken' }), terms)).toBe('dry');
    expect(sweetnessFilterValue(wine({ name: 'Riesling Kabinett' }), terms)).toBe(NOT_STATED);
  });

  test('a wine with no scale is found by no sweetness filter, "not-stated" included', () => {
    expect(sweetnessFilterValue(wine({ type: 'fortified', name: 'Tawny Port' }), terms)).toBe('');
    expect(sweetnessFilterValue(wine({ nonWine: true }), terms)).toBe('');
    expect(sweetnessFilterValue(null, terms)).toBe('');
    expect(parseSweetnessFilter('not-stated').has('')).toBe(false);
  });
});
