/**
 * Cellar search on MongoDB (services/bottleSearch) — the replacement for the
 * Meilisearch `bottles` index. Before the switch it was compared with the
 * index on a copy of real cellars: 24,370 searches (typos, partial words,
 * filters, sorts, history), the same bottles and counts in every one, the
 * same order in 99.9%. These tests pin the behaviour that comparison measured.
 *
 * The models are mocked: Bottle.find / WineDefinition.find return the fixture
 * rows, and the tests read back what was asked of them.
 */

jest.mock('../models/Bottle', () => ({ find: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));

const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { searchBottles, bottleFacets, _internal } = require('./bottleSearch');

const oid = (n) => String(n).padStart(24, '0');
const CELLAR = oid(1);

const FRANCE = { _id: oid(901), name: 'France' };
const ITALY = { _id: oid(902), name: 'Italy' };
const PORTUGAL = { _id: oid(903), name: 'Portugal' };
const SPAIN = { _id: oid(904), name: 'Spain' };
const BORDEAUX = { _id: oid(911), name: 'Bordeaux' };
const PIEDMONT = { _id: oid(912), name: 'Piedmont' };
const DOURO = { _id: oid(913), name: 'Douro' };
const BURGUNDY = { _id: oid(914), name: 'Burgundy' };
const RIOJA = { _id: oid(915), name: 'Rioja' };
const CABERNET = { _id: oid(921), name: 'Cabernet Sauvignon' };
const MERLOT = { _id: oid(922), name: 'Merlot' };
const NEBBIOLO = { _id: oid(923), name: 'Nebbiolo' };
const CHARDONNAY = { _id: oid(924), name: 'Chardonnay' };
const TEMPRANILLO = {
  _id: oid(925),
  name: 'Tempranillo',
  regionalNames: [{ country: PORTUGAL._id, region: DOURO._id, name: 'Tinta Roriz' }],
};

const wine = (n, fields) => ({ _id: oid(n), ...fields });
const MARGAUX = wine(101, { name: 'Château Margaux', producer: 'Château Margaux', appellation: 'Margaux', type: 'red', country: FRANCE, region: BORDEAUX, grapes: [CABERNET, MERLOT] });
const PALMER = wine(102, { name: 'Château Palmer', producer: 'Château Palmer', appellation: 'Margaux', type: 'red', country: FRANCE, region: BORDEAUX, grapes: [MERLOT, CABERNET] });
const BAROLO = wine(103, { name: 'Barolo Cannubi', producer: 'Brezza', appellation: 'Barolo', type: 'red', country: ITALY, region: PIEDMONT, grapes: [NEBBIOLO] });
const CHABLIS = wine(104, { name: 'Chablis Premier Cru', producer: 'William Fèvre', appellation: 'Chablis', type: 'white', country: FRANCE, region: BURGUNDY, grapes: [CHARDONNAY] });
const PORT = wine(105, { name: 'Vintage Port', producer: 'Quinta do Noval', appellation: 'Porto', type: 'fortified', country: PORTUGAL, region: DOURO, grapes: [TEMPRANILLO] });
const RESERVA = wine(106, { name: 'Viña Ardanza Reserva', producer: 'La Rioja Alta', appellation: 'Rioja', type: 'red', country: SPAIN, region: RIOJA, grapes: [TEMPRANILLO] });
const WINES = [MARGAUX, PALMER, BAROLO, CHABLIS, PORT, RESERVA];

const at = (day) => new Date(Date.UTC(2026, 0, day));
const bottle = (n, w, extra = {}) => ({
  _id: oid(n), wineDefinition: w ? w._id : null, vintage: '2015', price: 0, rating: 0, createdAt: at(n), ...extra,
});
const BOTTLES = [
  bottle(201, MARGAUX, { vintage: '2015', price: 900 }),
  bottle(202, MARGAUX, { vintage: '2010', price: 1100 }),
  bottle(203, PALMER, { vintage: '2015', price: 400 }),
  bottle(204, BAROLO, { vintage: '2016', price: 80 }),
  bottle(205, CHABLIS, { vintage: '2019', price: 40 }),
  bottle(206, PORT, { vintage: 'NV', price: 60 }),
  bottle(207, RESERVA, { vintage: 'Nv', price: 30 }),
  bottle(208, RESERVA, { vintage: 'NV', price: 30 }),
  // A bottle still waiting for its wine: findable by its own notes/location.
  bottle(209, null, { vintage: '2020', notes: 'Gift from Anna', location: 'Rack 3' }),
];

let lastBottleQuery;
let lastSelect;
function load(bottles = BOTTLES, wines = WINES) {
  Bottle.find.mockImplementation((query) => {
    lastBottleQuery = query;
    return {
      select: jest.fn((fields) => {
        lastSelect = fields;
        return { lean: jest.fn().mockResolvedValue(bottles.map((b) => ({ ...b }))) };
      }),
    };
  });
  WineDefinition.find.mockImplementation((query) => {
    const wanted = new Set(query._id.$in.map(String));
    const chain = {
      select: jest.fn(() => chain),
      populate: jest.fn(() => chain),
      lean: jest.fn().mockResolvedValue(wines.filter((w) => wanted.has(String(w._id)))),
    };
    return chain;
  });
}

const idsOf = (res) => res.ids.map((id) => Number(id));
const search = (query, opts = {}) => searchBottles(query, { cellarId: CELLAR, limit: 1000, ...opts });

beforeEach(() => {
  jest.clearAllMocks();
  lastBottleQuery = undefined;
  lastSelect = undefined;
  load();
});

describe('scope — never unscoped (security audit 2026-09-02, D10-5)', () => {
  test.each([
    ['an empty cellar list (a user who owns no cellar)', { cellarIds: [] }],
    ['no scope at all', {}],
    ['ids that are not ObjectIds', { cellarIds: ['"', 'x" OR 1'] }],
  ])('%s matches nothing without touching the database', async (_label, scope) => {
    const res = await searchBottles('wine', scope);
    expect(res).toMatchObject({ ids: [], total: 0 });
    expect(Bottle.find).not.toHaveBeenCalled();
  });

  test('one cellar, several cellars — exactly those', async () => {
    await searchBottles('x', { cellarId: CELLAR });
    expect(lastBottleQuery.cellar).toEqual({ $in: [CELLAR] });
    await searchBottles('x', { cellarIds: [CELLAR, oid(2), 'junk'] });
    expect(lastBottleQuery.cellar).toEqual({ $in: [CELLAR, oid(2)] });
  });

  test.each([
    ['active', { status: { $nin: ['drank', 'gifted', 'sold', 'other', 'ordered'] } }],
    ['ordered', { status: 'ordered' }],
    ['consumed', { status: { $in: ['drank', 'gifted', 'sold', 'other'] } }],
  ])('statusFilter %s', async (statusFilter, expected) => {
    await search('x', { statusFilter });
    expect(lastBottleQuery).toMatchObject(expected);
  });

  test('statusFilter all adds no status condition', async () => {
    await search('x', { statusFilter: 'all' });
    expect(lastBottleQuery).not.toHaveProperty('status');
  });

  test('notes and location are only loaded when there is text to match', async () => {
    await search('');
    expect(lastSelect).not.toMatch(/notes|location/);
    await search('anna');
    expect(lastSelect).toMatch(/notes/);
    expect(lastSelect).toMatch(/location/);
  });
});

describe('matching like the index did', () => {
  test('case and accents are ignored', async () => {
    expect(idsOf(await search('CHATEAU PALMER'))[0]).toBe(203);
    expect(idsOf(await search('fevre'))).toEqual([205]);
  });

  test.each([
    ['chardonay', 205],      // 9 letters: up to two typos
    ['barollo', 204],        // 7 letters: one typo
    ['nebiolo', 204],
    ['xhardonnay', 205],     // a wrong first letter counts as two typos (10 letters)
  ])('typo "%s" still finds the wine', async (query, expected) => {
    expect(idsOf(await search(query))).toContain(expected);
  });

  test('short words get no typos, and a wrong first letter needs a long word', async () => {
    expect((await search('rija ')).total).toBe(0);            // 4 letters: exact only
    expect((await search('xarolo ')).total).toBe(0);          // 6 letters: a first-letter typo costs 2, 1 allowed
    expect(idsOf(await search('barola '))).toEqual([204]);     // …while one ordinary typo is fine
  });

  test('the last word matches as a prefix while it is still being typed', async () => {
    expect(idsOf(await search('barol'))).toEqual([204]);
    expect(idsOf(await search('chateau marg', { sort: '-createdAt' }))).toEqual([202, 201, 203]);
    // Ending in a space: the word is finished, so no prefix match.
    expect((await search('barol ')).total).toBe(1);   // "barol" → "barolo" is still one typo
    expect((await search('marg ')).total).toBe(0);
  });

  test('"chateu margo" finds Château Margaux first', async () => {
    const res = await search('chateu margo', { sort: '-createdAt' });
    expect(idsOf(res).slice(0, 2)).toEqual([202, 201]);
  });

  test('several words: all of them first, then the leading ones — the first word must match', async () => {
    const res = await search('chateau margaux 2015', { sort: '-createdAt' });
    // Château Margaux 2015 and Palmer 2015 (appellation Margaux) have all three
    // words — Château Margaux's closer together; the 2010 only the leading two.
    expect(idsOf(res)).toEqual([201, 203, 202]);
    // A bottle matching only a later word is not a hit.
    expect(idsOf(await search('xyz margaux'))).toEqual([]);
  });

  test('words typed apart match one written together, and the reverse', async () => {
    load([bottle(301, wine(301, { name: 'Châteauneuf-du-Pape', producer: 'X', type: 'red' })),
      bottle(302, wine(302, { name: 'Pinot Noir', producer: 'Y', type: 'red' }))],
    [wine(301, { name: 'Châteauneuf du Pape', producer: 'X', type: 'red' }),
      wine(302, { name: 'Pinot Noir', producer: 'Y', type: 'red' })]);
    expect(idsOf(await search('chateau neuf'))).toEqual([301]);
    expect(idsOf(await search('pinotnoir'))).toEqual([302]);
    expect(idsOf(await search('pino tnoir'))).toEqual([302]);
  });

  test('the regional grape name finds the bottle it applies to — and only that one', async () => {
    // Tempranillo is "Tinta Roriz" on a Douro wine (the card says so), not in Rioja.
    expect(idsOf(await search('tinta roriz'))).toEqual([206]);
    expect(idsOf(await search('tempranillo'))).toEqual(expect.arrayContaining([206, 207, 208]));
  });

  test('a bottle without its wine yet is found by its own notes and location', async () => {
    expect(idsOf(await search('anna'))).toEqual([209]);
    expect(idsOf(await search('rack 3'))).toEqual([209]);
  });
});

describe('ranking', () => {
  test('a more important field ranks first: the wine name before the appellation', async () => {
    // Palmer (appellation Margaux) comes after both Château Margaux bottles
    // (name) whichever way the sort runs — the field ranks before the sort.
    expect(idsOf(await search('margaux', { sort: 'createdAt' }))).toEqual([201, 202, 203]);
    expect(idsOf(await search('margaux', { sort: '-createdAt' }))).toEqual([202, 201, 203]);
  });

  test('fewer typos first', async () => {
    load([bottle(401, wine(401, { name: 'Merlot', producer: 'A', type: 'red' })),
      bottle(402, wine(402, { name: 'Merlo', producer: 'B', type: 'red' }))],
    [wine(401, { name: 'Merlot', producer: 'A', type: 'red' }),
      wine(402, { name: 'Merlo', producer: 'B', type: 'red' })]);
    expect(idsOf(await search('merlo ', { sort: 'createdAt' }))).toEqual([402, 401]);
  });

  test('the typo rule decides first: an exact country beats a one-typo word in the name', () => {
    const w = wine(501, { name: 'Côtes de Francs', country: FRANCE });
    const doc = _internal.buildSearchDoc({ _id: w._id, vintage: '' }, w);
    doc.fields = _internal.FIELDS.map((n) => _internal.tokenize(doc.values[n]));
    // "France" matched exactly in the country (field 3) — not "Francs" (one
    // typo) in the name, as the index ranked it.
    expect(_internal.rankDocument(doc, _internal.parseQuery('france'), new Map()))
      .toMatchObject({ typos: 0, attribute: 3 });
  });

  test('the requested sort orders bottles that rank equally; history-style no-sort keeps id order', async () => {
    expect(idsOf(await search('', { sort: '-price' }))).toEqual([202, 201, 203, 204, 206, 205, 207, 208, 209]);
    expect(idsOf(await search(''))).toEqual([201, 202, 203, 204, 205, 206, 207, 208, 209]);
  });

  test('vintage sorts numbers first, then NV/Nv — as the index sorted strings', async () => {
    const res = await search('', { sort: 'vintage' });
    expect(idsOf(res).slice(0, 6)).toEqual([202, 201, 203, 204, 205, 209]);
    expect(idsOf(res).slice(6).sort()).toEqual([206, 207, 208]);
    expect(idsOf(await search('', { sort: '-vintage' }))).toEqual([206, 207, 208, 209, 205, 204, 201, 203, 202]);
  });
});

describe('filters', () => {
  test('type, country, region, grapes, vintage', async () => {
    expect(idsOf(await search('', { type: 'white' }))).toEqual([205]);
    expect(idsOf(await search('', { type: 'red,fortified' })).sort()).toEqual([201, 202, 203, 204, 206, 207, 208]);
    expect(idsOf(await search('', { countryId: ITALY._id }))).toEqual([204]);
    expect(idsOf(await search('', { regionId: `${DOURO._id},${PIEDMONT._id}` }))).toEqual([204, 206]);
    expect(idsOf(await search('', { grapeIds: [NEBBIOLO._id, CHARDONNAY._id] }))).toEqual([204, 205]);
    expect(idsOf(await search('', { vintage: '2015' }))).toEqual([201, 203]);
  });

  test('appellation and vintage compare case-insensitively, as the index did', async () => {
    expect(idsOf(await search('', { appellation: 'MARGAUX' }))).toEqual([201, 202, 203]);
    expect(idsOf(await search('', { vintage: 'nv' }))).toEqual([206, 207, 208]);
  });

  test('invalid values are ignored — a list with none left filters nothing', async () => {
    expect((await search('', { type: 'purple' })).total).toBe(9);
    expect((await search('', { countryId: 'not-an-id' })).total).toBe(9);
    expect((await search('', { vintage: '"2015"' })).total).toBe(9);
  });

  test('filters and text together', async () => {
    expect(idsOf(await search('chateau', { vintage: '2010' }))).toEqual([202]);
  });
});

describe('results, pages and facets', () => {
  test('limit/offset page the ranked list; total counts every hit', async () => {
    const page = await search('', { sort: 'createdAt', limit: 3, offset: 3 });
    expect(idsOf(page)).toEqual([204, 205, 206]);
    expect(page.total).toBe(9);
    const none = await search('', { limit: 0 });
    expect(none.ids).toEqual([]);
    expect(none.total).toBe(9);
  });

  test('facets count the hits; base facets count the whole scope', async () => {
    const res = await search('chateau');
    expect(res.facetDistribution.type).toEqual({ red: 3 });
    expect(res.facetDistribution.appellation).toEqual({ Margaux: 3 });
    expect(res.baseFacetDistribution.type).toEqual({ red: 6, white: 1, fortified: 1 });
    expect(res.baseFacetDistribution.countryName).toEqual({ France: 4, Italy: 1, Portugal: 1, Spain: 2 });
    expect(res.baseFacetDistribution.grapeIds[MERLOT._id]).toBe(3);
  });

  test('empty values are not counted; NV and Nv are one value under the common spelling', async () => {
    const { baseFacetDistribution: f } = await search('');
    expect(f.type).not.toHaveProperty('');
    expect(f.vintage).toEqual({ 2010: 1, 2015: 2, 2016: 1, 2019: 1, 2020: 1, NV: 3 });
  });

  // routes/cellars pages over these without loading the hits (ids first).
  test('withHits: every hit in rank order with what grouping needs; a wine that no longer exists reads as none', async () => {
    load([...BOTTLES, bottle(210, { _id: oid(199) }, { vintage: '2001', bottleSize: '1500ml' })]);
    const res = await search('', { sort: 'createdAt', limit: 2, withHits: true });
    expect(lastSelect).toContain('bottleSize');
    expect(idsOf(res)).toEqual([201, 202]); // the page, as before
    expect(res.hits.map((h) => Number(h.id))).toEqual([201, 202, 203, 204, 205, 206, 207, 208, 209, 210]);
    expect(res.hits[0]).toEqual({ id: oid(201), wineDefinition: MARGAUX._id, vintage: '2015', bottleSize: undefined });
    expect(res.hits[8]).toMatchObject({ id: oid(209), wineDefinition: null });
    expect(res.hits[9]).toEqual({ id: oid(210), wineDefinition: null, vintage: '2001', bottleSize: '1500ml' });

    const ranked = await search('margaux', { withHits: true });
    expect(ranked.hits.map((h) => h.id)).toEqual(ranked.ids);

    const without = await search('', {});
    expect(without).not.toHaveProperty('hits');
  });

  test('facetMeta maps the names the modal shows to the ids it filters by', async () => {
    const { facetMeta } = await search('');
    expect(facetMeta.countries.Portugal).toBe(PORTUGAL._id);
    expect(facetMeta.regions.Douro).toBe(DOURO._id);
    expect(facetMeta.grapes.Tempranillo).toBe(TEMPRANILLO._id);
  });
});

describe('bottleFacets — the plain cellar page', () => {
  test('one grouping query, counted per (wine, vintage) group', async () => {
    Bottle.aggregate.mockResolvedValue([
      { _id: { wine: MARGAUX._id, vintage: '2015' }, count: 2 },
      { _id: { wine: PORT._id, vintage: 'NV' }, count: 1 },
      { _id: { wine: null, vintage: '2020' }, count: 4 },
    ]);
    const res = await bottleFacets({ cellarId: CELLAR });
    const [pipeline] = Bottle.aggregate.mock.calls[0];
    expect(String(pipeline[0].$match.cellar.$in[0])).toBe(CELLAR);
    expect(pipeline[0].$match.status).toEqual({ $nin: ['drank', 'gifted', 'sold', 'other', 'ordered'] });
    expect(res.facetDistribution.vintage).toEqual({ 2015: 2, NV: 1, 2020: 4 });
    expect(res.facetDistribution.countryName).toEqual({ France: 2, Portugal: 1 });
    expect(res.baseFacetDistribution).toBe(res.facetDistribution);
    expect(res.facetMeta.regions).toEqual({ Bordeaux: BORDEAUX._id, Douro: DOURO._id });
  });

  test('no usable scope → empty facets, no query', async () => {
    const res = await bottleFacets({ cellarIds: [] });
    expect(Bottle.aggregate).not.toHaveBeenCalled();
    expect(res.facetDistribution.type).toEqual({});
  });
});

describe('text helpers', () => {
  test('words split on anything that is not a letter or digit', () => {
    expect(_internal.toWords('Châteauneuf-du-Pape')).toEqual(['chateauneuf', 'du', 'pape']);
    expect(_internal.toWords('St.Emilion')).toEqual(['st', 'emilion']);
    expect(_internal.toWords('Œil de Perdrix')).toEqual(['oeil', 'de', 'perdrix']);
  });

  test('a hard separator (comma or full stop and a space, semicolon) moves the next word 8 on', () => {
    expect(_internal.tokenize('Cabernet Sauvignon, Merlot').positions).toEqual([0, 1, 9]);
    expect(_internal.tokenize('a,b; c. d').positions).toEqual([0, 1, 9, 17]);
  });

  // Review 2026-09-27: U+FDFA folds into four words, so 5,000 of them (a note
  // at its length limit) became 20,000 words, weighing ~7× what the kept
  // document is charged for.
  test('a field keeps at most one word per two characters, as real text has', () => {
    const dense = 'a b '.repeat(1250); // 5,000 characters, 2,500 words
    expect(_internal.tokenize(dense).words).toHaveLength(2500);
    expect(_internal.tokenize('ﷺ').words).toEqual(['صلى', 'الله', 'عليه', 'وسلم']);
    expect(_internal.tokenize('ﷺ'.repeat(5000)).words).toHaveLength(2500);
    expect(_internal.tokenize('½ bottle, 1st growth').words).toEqual(['1', '2', 'bottle', '1st', 'growth']);
  });

  test('edit distance counts a swap as one, and measures a prefix for the last word', () => {
    const chars = (s) => Array.from(s);
    expect(_internal.editDistance(chars('chardonany'), chars('chardonnay'), 2, false)).toBe(1);
    expect(_internal.editDistance(chars('margo'), chars('margaux'), 1, true)).toBe(1);
    expect(_internal.editDistance(chars('margo'), chars('margaux'), 1, false)).toBe(2);
  });
});

// ── Bounds on the work one request can ask for (audit 2026-09-27 H1) ────────
// The edit distance is quadratic in word length, and a search runs on the one
// Node process every user shares. Before these bounds, one 4,999-character
// query word against 50 bottles each carrying a distinct 4,999-character word
// in its notes cost ~10 s of CPU in a single request.
describe('long words and long queries', () => {
  test('a word is read up to 32 characters, in a query and in a bottle alike — so the two still compare equal', () => {
    const long = 'x'.repeat(4999);
    expect(_internal.MAX_WORD_CHARS).toBe(32);
    expect(_internal.toWords(long)).toEqual(['x'.repeat(32)]);
    expect(_internal.tokenize(`${long} merlot`).words).toEqual(['x'.repeat(32), 'merlot']);
    const parsed = _internal.parseQuery(long);
    expect(parsed.words).toEqual(['x'.repeat(32)]);
    expect(_internal.matchWord(parsed.elements[0], _internal.toWords(long)[0])).toEqual({ typos: 0, exact: true });
  });

  test('no typo tolerance beyond 24 characters — such words match exactly or as a prefix only', () => {
    expect(_internal.MAX_TYPO_WORD_CHARS).toBe(24);
    expect(_internal.typoBudget(24)).toBe(2);
    expect(_internal.typoBudget(25)).toBe(0);
    const element = _internal.parseQuery('y'.repeat(25)).elements[0];
    expect(element.budget).toBe(0);
    expect(_internal.matchWord(element, 'y'.repeat(25))).toEqual({ typos: 0, exact: true });
    expect(_internal.matchWord(element, 'y'.repeat(30))).toEqual({ typos: 0, exact: false }); // still being typed
    expect(_internal.matchWord(element, `${'y'.repeat(24)}z`)).toBeNull();
    // Up to the bound, typos are read as before.
    const shorter = _internal.parseQuery('y'.repeat(24)).elements[0];
    expect(_internal.matchWord(shorter, `${'y'.repeat(23)}z`)).toEqual({ typos: 1, exact: false });
  });

  test('the query is read up to 200 characters', () => {
    expect(_internal.MAX_QUERY_CHARS).toBe(200);
    const parsed = _internal.parseQuery(`${'a'.repeat(198)} merlot`); // 198 + space + 'm' = 200
    expect(parsed.words).toEqual(['a'.repeat(32), 'm']);
    expect(parsed.elements.find((e) => e.text === 'm').prefix).toBe(true);
  });

  test('the case measured before the fix (50 bottles × 4,999-character words) now costs milliseconds', () => {
    const query = _internal.parseQuery('q'.repeat(4999));
    const docs = Array.from({ length: 50 }, (_, i) => {
      const w = wine(600 + i, { name: 'Cuvée', producer: 'P', type: 'red' });
      const doc = _internal.buildSearchDoc({ _id: oid(700 + i), vintage: '', notes: `k${i}${'q'.repeat(4998)}` }, w);
      doc.fields = _internal.FIELDS.map((n) => _internal.tokenize(doc.values[n]));
      return doc;
    });
    const started = process.hrtime.bigint();
    const memo = new Map();
    for (const doc of docs) _internal.rankDocument(doc, query, memo);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(1000); // was ~10,000 ms
  });
});

// ── Kept documents (typing and paging load the cellar once) ─────────────────
// Loading a big cellar's bottles and wines and splitting every field into
// words was most of each search request. With the scope's data version
// (routes/cellars passes its owners'), the built documents are kept while it
// matches, for at most DOCS_TTL_MS.

describe('kept documents', () => {
  afterEach(() => {
    _internal.forgetAllDocs();
    _internal.setDocsMaxBytes();
    jest.restoreAllMocks();
  });

  test('with a version: loaded once, then reused while it matches, for text and filters alike', async () => {
    const first = await search('', { type: 'red', version: 'u1:5' });
    // Kept documents carry notes and location, so a text search can reuse them.
    expect(lastSelect).toContain('notes location');
    const anna = await search('anna', { version: 'u1:5' });
    const again = await search('margaux', { version: 'u1:5', offset: 1 });
    expect(Bottle.find).toHaveBeenCalledTimes(1);
    expect(WineDefinition.find).toHaveBeenCalledTimes(1);
    expect(first.total).toBe(6);
    expect(idsOf(anna)).toEqual([209]);
    expect(again.total).toBe(3);
  });

  test('a new version, another scope or the other status loads again', async () => {
    await search('a', { version: 'u1:5' });
    await search('a', { version: 'u1:6' });
    await search('a', { version: 'u1:6', cellarId: oid(2) });
    await search('a', { version: 'u1:6', statusFilter: 'consumed' });
    expect(Bottle.find).toHaveBeenCalledTimes(4);
  });

  test('kept at most DOCS_TTL_MS, whatever the version says', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await search('a', { version: 'u1:5' });
    clock.mockReturnValue(now + _internal.DOCS_TTL_MS - 1);
    await search('a', { version: 'u1:5' });
    expect(Bottle.find).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + _internal.DOCS_TTL_MS);
    await search('a', { version: 'u1:5' });
    expect(Bottle.find).toHaveBeenCalledTimes(2);
    // An expired scope is dropped on the next call, not only when pushed out.
    clock.mockReturnValue(now + 3 * _internal.DOCS_TTL_MS);
    await search('a', { version: 'u1:5', cellarId: oid(2) });
    expect(_internal.keptScopes()).toBe(1);
  });

  test('without a version nothing is kept, and a filter-only request leaves notes out', async () => {
    await search('', { type: 'red' });
    expect(lastSelect).not.toContain('notes');
    await search('', { type: 'red' });
    expect(Bottle.find).toHaveBeenCalledTimes(2);
    expect(_internal.keptScopes()).toBe(0);
  });

  test('bounded: the least recently used scope goes first; a scope larger than the bound is never kept', async () => {
    await search('a', { version: 'v', cellarId: oid(10) });
    const oneScope = _internal.keptBytes();
    _internal.forgetAllDocs();
    _internal.setDocsMaxBytes(oneScope * 2); // room for two scopes
    await search('a', { version: 'v', cellarId: oid(11) });
    await search('a', { version: 'v', cellarId: oid(12) });
    await search('a', { version: 'v', cellarId: oid(11) }); // 11 is now the most recent
    await search('a', { version: 'v', cellarId: oid(13) }); // 12 goes
    expect(_internal.keptScopes()).toBe(2);
    Bottle.find.mockClear();
    await search('a', { version: 'v', cellarId: oid(11) });
    expect(Bottle.find).not.toHaveBeenCalled();
    await search('a', { version: 'v', cellarId: oid(12) });
    expect(Bottle.find).toHaveBeenCalledTimes(1);

    _internal.forgetAllDocs();
    _internal.setDocsMaxBytes(oneScope - 1);
    await search('a', { version: 'v' });
    expect(_internal.keptScopes()).toBe(0);
  });

  // Review 2026-09-27: the bound counted documents, and a document with the
  // longest notes weighs up to ~20× an ordinary one — 8,000 of them would
  // have held several hundred MB.
  test('a document is charged for its text, so long notes fill the bound sooner', async () => {
    const plain = _internal.docBytes(_internal.buildSearchDoc(BOTTLES[0], MARGAUX));
    const long = _internal.docBytes(_internal.buildSearchDoc(
      { ...BOTTLES[0], notes: 'a b '.repeat(1250), location: 'x'.repeat(500) }, MARGAUX,
    ));
    expect(plain).toBeGreaterThan(4 * 1024);
    expect(plain).toBeLessThan(6 * 1024);
    expect(long).toBeGreaterThan(90 * 1024);

    load([bottle(301, MARGAUX, { notes: 'a b '.repeat(1250), location: 'x'.repeat(500) })]);
    await search('a', { version: 'v', cellarId: oid(21) });
    expect(_internal.keptBytes()).toBe(long);
  });
});
