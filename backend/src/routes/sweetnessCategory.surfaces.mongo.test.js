/**
 * The sweetness category on the REAL app against a REAL MongoDB: the filter,
 * its counts and the two fields, on every surface that carries them.
 *
 * WHY THIS TEST EXISTS:
 * The category is never stored. It is read from the wine record each time,
 * by a reader that loads the record itself (services/sweetnessCategory) —
 * because the member reads leave out the curator's "the word is the name"
 * mark, and the sweetness style is select: false on the model. Mocked models
 * show neither. What must hold on real rows:
 *  - one wine reads the same everywhere: in the cellar filter and its counts,
 *    in the bottle list's filter, on the bottle and wine reads, in the
 *    inventory, in the offline copy and over MCP;
 *  - a wine marked sweetnessInName is not read by its name on a read that
 *    never loaded the mark;
 *  - a fortified wine and a drink that is not wine are found by no sweetness
 *    filter and counted under none, "not-stated" included;
 *  - the counts under a filter are the list under that filter.
 *
 * Every request stays on the test stack: FRONTEND_URL is a dead local
 * address and fetch follows no redirect.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_sweetcat`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sweet-category-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'sweetcat-meili-key-0123456789abcdef';
process.env.MEILI_URL = 'http://127.0.0.1:1';
process.env.FRONTEND_URL = 'http://127.0.0.1:9';

// The Meilisearch client is ESM-only (Jest cannot load it); no surface here
// searches through it.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_sweetcat'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('routes/sweetnessCategory.surfaces.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

// What each wine of the test world reads as: [category, basis], or null for
// a wine that could state one and does not, or false for a wine with no scale.
const EXPECTED = {
  labelDry: ['dry', 'label'],
  nameOffDry: ['off-dry', 'name'],
  styleMedium: ['medium-sweet', 'style'],
  tierSweet: ['sweet', 'tier'],
  ggDry: ['dry', 'tier'],
  brut: ['dry', 'name'],
  typeSweet: ['sweet', 'type'],
  marked: null,
  kabinett: null,
  port: false,
  cider: false,
};

describeWithMongo('the sweetness category on every surface (real MongoDB)', () => {
  let server; let base; let token; let ada; let home; let annex; let allTools;
  let WineDefinition; let Bottle; let categories;
  const wines = {}; const bottles = {};

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!/^cellarion_contract/.test(mongoose.connection.name || '')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.dropDatabase();

    const User = require('../models/User');
    const Country = require('../models/Country');
    const Region = require('../models/Region');
    const Cellar = require('../models/Cellar');
    const SweetnessTerm = require('../models/SweetnessTerm');
    const ExchangeRateSnapshot = require('../models/ExchangeRateSnapshot');
    WineDefinition = require('../models/WineDefinition');
    Bottle = require('../models/Bottle');
    categories = require('../services/sweetnessCategory');
    await require('../services/sweetnessOps').ensureSweetnessSeed();
    // The day's exchange rates, so no request reaches the rate API.
    await ExchangeRateSnapshot.create({ date: new Date().toISOString().slice(0, 10), rates: { USD: 1, EUR: 0.92 }, fetchedAt: new Date() });

    ada = await User.create({ username: 'ada', email: 'ada@sweetcat.test', password: 'Sweet-Category-Passw0rd!' });
    const germany = await Country.create({ name: 'Germany', normalizedName: 'germany', createdBy: ada._id });
    const mosel = await Region.create({ name: 'Mosel', normalizedName: 'mosel', country: germany._id, createdBy: ada._id });
    const term = async (name, scale) => (await SweetnessTerm.findOne({ name, scale }))._id;

    const wine = async (key, fields) => {
      wines[key] = await WineDefinition.create({
        producer: 'Weingut Beispiel', country: germany._id, region: mosel._id, type: 'white',
        normalizedKey: `${key}|weingut beispiel|`, createdBy: ada._id, ...fields,
      });
    };
    await wine('labelDry', { name: 'Riesling Alte Reben', labelSweetness: await term('trocken', 'still') });
    await wine('nameOffDry', { name: 'Riesling feinherb' });
    await wine('styleMedium', {
      name: 'Scharzhofberger Riesling',
      sweetnessStyle: { term: await term('lieblich', 'still'), source: 'producer', url: 'https://weingut.example/scharzhofberger' },
    });
    await wine('tierSweet', { name: 'Riesling Beerenauslese' });
    await wine('ggDry', { name: 'Kirchenstück Riesling GG' });
    await wine('brut', { name: 'Cuvée Réserve Brut', type: 'sparkling' });
    await wine('typeSweet', { name: 'Cuvée Dorée', type: 'dessert' });
    // The curator's mark: "Brut" is part of this name, not a statement.
    await wine('marked', { name: 'Brut Premier', type: 'sparkling', sweetnessInName: true });
    await wine('kabinett', { name: 'Riesling Kabinett' });
    await wine('port', { name: 'Tawny Reserve', type: 'fortified' });
    await wine('cider', { name: 'Apfel Cidre' });
    await WineDefinition.collection.updateOne({ _id: wines.cider._id }, { $set: { nonWine: true, type: null } });

    home = await Cellar.create({ name: 'Home', user: ada._id });
    annex = await Cellar.create({ name: 'Annex', user: ada._id });
    // One bottle of each wine at home; a second dry one, and one drunk
    // off-dry bottle, so counts are bottles and the history has a row.
    for (const key of Object.keys(wines)) {
      bottles[key] = await Bottle.create({ user: ada._id, cellar: home._id, wineDefinition: wines[key]._id, vintage: '2021' });
    }
    bottles.labelDry2 = await Bottle.create({ user: ada._id, cellar: home._id, wineDefinition: wines.labelDry._id, vintage: '2022' });
    bottles.drunk = await Bottle.create({
      user: ada._id, cellar: home._id, wineDefinition: wines.nameOffDry._id, vintage: '2019',
      status: 'drank', consumedAt: new Date(), consumedReason: 'drank',
    });
    bottles.annexSweet = await Bottle.create({ user: ada._id, cellar: annex._id, wineDefinition: wines.tierSweet._id, vintage: '2018' });
    bottles.noWine = await Bottle.create({ user: ada._id, cellar: home._id, wineDefinition: null, vintage: '2020' });

    token = jwt.sign({ id: String(ada._id), roles: ['user'] }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    server = http.createServer(require('../app')).listen(0);
    require('../mcp/tools');
    ({ allTools } = require('../mcp/registry'));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 180000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  let ip = 0;
  const get = async (path) => {
    ip += 1;
    const res = await fetch(base + path, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': `10.8.${(ip >> 8) & 255}.${ip & 255}`, Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    expect([path, res.status]).toEqual([path, 200]);
    return json;
  };
  const tool = async (name, args) => {
    const t = allTools().find((x) => x.name === name);
    const parsed = require('zod').z.object(t.inputSchema).parse(args);
    const ctx = { user: { id: String(ada._id), roles: ['user'] }, req: { user: { id: String(ada._id), roles: ['user'] } } };
    const res = await t.handler(parsed, ctx);
    return JSON.parse(res.content[0].text);
  };

  const keyOf = (wineId) => Object.keys(wines).find((k) => String(wines[k]._id) === String(wineId));
  const pair = (w) => (w.sweetnessCategory ? [w.sweetnessCategory, w.sweetnessCategoryBasis] : null);
  const expectedPair = (key) => EXPECTED[key] || null;
  // The wines of the test world a filter value finds, as sorted keys.
  const keysFor = (...values) => Object.keys(EXPECTED).filter((k) => {
    const e = EXPECTED[k];
    return e === false ? false : values.includes(e ? e[0] : 'not-stated');
  }).sort();

  describe('the reader', () => {
    test('every wine reads as the record says, the style and the name mark from the reader\'s own load', async () => {
      const read = await categories.readSweetnessCategories(Object.values(wines).map((w) => w._id));
      const got = Object.fromEntries(Object.keys(wines).map((k) => {
        const r = read.get(String(wines[k]._id));
        return [k, r ? [r.category, r.basis] : null];
      }));
      expect(got).toEqual(Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, expectedPair(k)])));
    });

    test('an id that names no wine has no entry, and nothing that is not an id is queried', async () => {
      const read = await categories.readSweetnessCategories([new mongoose.Types.ObjectId(), 'not-an-id', null, { $ne: null }]);
      expect(read.size).toBe(0);
    });

    test('a lean member read of the marked wine gets null: the fields come from the reader, not from the read', async () => {
      const { WINE_POPULATE_LIST } = require('../config/constants');
      const b = await Bottle.findById(bottles.marked._id).populate(WINE_POPULATE_LIST).lean();
      expect(b.wineDefinition.sweetnessInName).toBeUndefined();
      await categories.attachSweetnessCategories([b.wineDefinition]);
      expect(pair(b.wineDefinition)).toBeNull();
      expect(b.wineDefinition).toHaveProperty('sweetnessCategoryBasis', null);
    });

    test('a Mongoose document is left alone', async () => {
      const doc = await WineDefinition.findById(wines.labelDry._id);
      await categories.attachSweetnessCategories(doc);
      expect(doc.toObject()).not.toHaveProperty('sweetnessCategory');
    });
  });

  describe('the cellar page', () => {
    const listed = (body) => body.bottles.items.map((b) => keyOf(b.wineDefinition?._id)).sort();

    test('the counts: bottles per category, the unstated ones, and no entry for a wine without a scale', async () => {
      const body = await get(`/api/cellars/${home._id}`);
      expect(body.baseFacets.sweetnessCategory).toEqual({ dry: 4, 'off-dry': 1, 'medium-sweet': 1, sweet: 2, 'not-stated': 2 });
      expect(body.facets.sweetnessCategory).toEqual(body.baseFacets.sweetnessCategory);
    });

    test.each([
      ['dry', ['brut', 'ggDry', 'labelDry', 'labelDry']],
      ['off-dry', ['nameOffDry']],
      ['medium-sweet', ['styleMedium']],
      ['sweet', ['tierSweet', 'typeSweet']],
      ['not-stated', ['kabinett', 'marked']],
      ['sweet,off-dry', ['nameOffDry', 'tierSweet', 'typeSweet']],
    ])('?sweetnessCategory=%s lists exactly those bottles', async (value, want) => {
      const body = await get(`/api/cellars/${home._id}?sweetnessCategory=${value}`);
      expect(listed(body)).toEqual(want);
      expect(body.bottles.total).toBe(want.length);
    });

    test('grouped as the page asks, the cards and the bottles behind them', async () => {
      const body = await get(`/api/cellars/${home._id}?group=1&sweetnessCategory=dry`);
      expect(body.bottles.total).toBe(4);
      expect(body.bottles.bottleTotal).toBe(4);
    });

    test('a value that is no category finds nothing, and never the whole cellar', async () => {
      const body = await get(`/api/cellars/${home._id}?sweetnessCategory=brut`);
      expect(body.bottles.total).toBe(0);
    });

    test('with another filter, the counts of the sweetness section stay those of the other filter alone', async () => {
      const body = await get(`/api/cellars/${home._id}?type=sparkling&sweetnessCategory=dry`);
      expect(listed(body)).toEqual(['brut']);
      // Its own section counts what choosing another value would give.
      expect(body.facets.sweetnessCategory).toEqual({ dry: 1, 'not-stated': 1 });
      expect(body.facets.type).toEqual({ sparkling: 1, white: 3 });
    });

    test('the history and the view across cellars take the same filter', async () => {
      const history = await get(`/api/cellars/${home._id}/history?sweetnessCategory=off-dry`);
      expect(history.bottles.map((b) => String(b._id))).toEqual([String(bottles.drunk._id)]);
      expect((await get(`/api/cellars/${home._id}/history?sweetnessCategory=sweet`)).bottles).toEqual([]);
      const multi = await get(`/api/cellars/multi/bottles?cellars=${home._id},${annex._id}&sweetnessCategory=sweet`);
      expect(multi.bottles.items.map((b) => keyOf(b.wineDefinition?._id)).sort()).toEqual(['tierSweet', 'tierSweet', 'typeSweet']);
      expect(multi.facets.sweetnessCategory.sweet).toBe(3);
    });
  });

  describe('GET /api/bottles', () => {
    const listed = (body) => body.bottles.items.map((b) => keyOf(b.wineDefinition?._id)).sort();

    test.each([
      ['dry'], ['off-dry'], ['medium-sweet'], ['sweet'], ['not-stated'], ['dry,sweet'],
    ])('?sweetnessCategory=%s finds the wines that read so, in both cellars', async (value) => {
      const body = await get(`/api/bottles?sweetnessCategory=${value}&limit=200`);
      expect([...new Set(listed(body))]).toEqual(keysFor(...value.split(',')));
      for (const b of body.bottles.items) expect(value.split(',')).toContain(b.wineDefinition.sweetnessCategory || 'not-stated');
    });

    test('it pages in the database with the right total, and combines with a wine filter', async () => {
      const page = await get('/api/bottles?sweetnessCategory=dry&limit=2');
      expect(page.bottles.items).toHaveLength(2);
      expect(page.bottles.total).toBe(4);
      expect(listed(await get('/api/bottles?sweetnessCategory=dry&type=sparkling'))).toEqual(['brut']);
      expect((await get('/api/bottles?sweetnessCategory=sweet&type=sparkling')).bottles.total).toBe(0);
    });

    test('a value that is no category finds nothing; a bottle without a wine is found by none', async () => {
      expect((await get('/api/bottles?sweetnessCategory=fruity')).bottles.total).toBe(0);
      const all = await get('/api/bottles?sweetnessCategory=dry,off-dry,medium-sweet,sweet,not-stated&limit=200');
      expect(all.bottles.items.every((b) => b.wineDefinition)).toBe(true);
      // Everything but the fortified wine, the cider and the bottle without a wine.
      expect(all.bottles.total).toBe((await get('/api/bottles?limit=200')).bottles.total - 3);
    });

    test('every wine on the list carries both fields', async () => {
      const body = await get('/api/bottles?limit=200');
      for (const b of body.bottles.items.filter((x) => x.wineDefinition)) {
        expect([keyOf(b.wineDefinition._id), pair(b.wineDefinition)]).toEqual([keyOf(b.wineDefinition._id), expectedPair(keyOf(b.wineDefinition._id))]);
        expect(b.wineDefinition).not.toHaveProperty('sweetnessInName');
      }
    });
  });

  describe('the reads', () => {
    test.each(Object.keys(EXPECTED))('the bottle and the wine read of %s', async (key) => {
      const bottle = await get(`/api/bottles/${bottles[key]._id}`);
      expect(pair(bottle.bottle.wineDefinition)).toEqual(expectedPair(key));
      expect(bottle.bottle.wineDefinition).toHaveProperty('sweetnessCategoryBasis');
      if (key === 'cider') return; // the wine read hides a drink that is not wine
      const wine = await get(`/api/wines/${wines[key]._id}`);
      expect(pair(wine.wine)).toEqual(expectedPair(key));
    });

    test('the inventory and the offline copy carry what the reads carry', async () => {
      const inventory = await get('/api/inventory');
      const snapshot = await get('/api/offline/snapshot');
      for (const key of Object.keys(EXPECTED)) {
        const id = String(wines[key]._id);
        expect([key, pair(inventory.wines[id])]).toEqual([key, expectedPair(key)]);
        expect([key, pair(snapshot.wines[id])]).toEqual([key, expectedPair(key)]);
        expect(inventory.wines[id]).toHaveProperty('sweetnessCategoryBasis');
      }
    });
  });

  describe('analytics', () => {
    test('a rows query carries the category as a column; it cannot be grouped or filtered on', async () => {
      const { runQuery } = require('../services/analytics/queryEngine');
      const out = await runQuery(String(ada._id), { columns: ['wine.name', 'wine.sweetnessCategory'], limit: 100 });
      const byName = Object.fromEntries(out.rows.map((r) => [r.values['wine.name'], r.values['wine.sweetnessCategory']]));
      for (const key of Object.keys(EXPECTED)) {
        expect([key, byName[wines[key].name]]).toEqual([key, EXPECTED[key] ? EXPECTED[key][0] : null]);
      }
      await expect(runQuery(String(ada._id), { mode: 'grouped', dimensions: ['wine.sweetnessCategory'], measures: [{ field: '*', agg: 'count' }] }))
        .rejects.toThrow();
      await expect(runQuery(String(ada._id), { columns: ['wine.name'], filters: [{ field: 'wine.sweetnessCategory', op: 'eq', value: 'dry' }] }))
        .rejects.toThrow();
    });
  });

  describe('MCP', () => {
    test('search_bottles filters on it, and each row\'s wine carries the category', async () => {
      const dry = await tool('search_bottles', { sweetness: 'dry' });
      expect(dry.page.total).toBe(4);
      expect(dry.data.every((row) => row.wine.sweetness_category === 'dry')).toBe(true);
      const unstated = await tool('search_bottles', { sweetness: 'not-stated' });
      expect(unstated.data.map((row) => row.wine.name).sort()).toEqual(['Brut Premier', 'Riesling Kabinett']);
      expect(unstated.data.every((row) => row.wine.sweetness_category === null)).toBe(true);
      const sweet = await tool('search_bottles', { sweetness: 'sweet', query: 'riesling' });
      expect(sweet.data.map((row) => row.wine.name)).toEqual(['Riesling Beerenauslese', 'Riesling Beerenauslese']);
    });

    test('with reserved, the filter is dropped and the answer says so', async () => {
      const res = await tool('search_bottles', { sweetness: 'sweet', reserved: 'exclude' });
      expect(res.warnings).toContain('sweetness filter cannot be combined with reserved — ignored in this response.');
      expect(res.page.total).toBeGreaterThan(3);
    });

    test('get_wine and get_bottle carry the category and what it rests on', async () => {
      const wine = await tool('get_wine', { wine_id: String(wines.styleMedium._id) });
      expect(wine.data).toMatchObject({ sweetness_category: 'medium-sweet', sweetness_category_basis: 'style' });
      const marked = await tool('get_wine', { wine_id: String(wines.marked._id) });
      expect(marked.data).toMatchObject({ sweetness_category: null, sweetness_category_basis: null });
      const bottle = await tool('get_bottle', { bottle_id: String(bottles.ggDry._id) });
      expect(bottle.data.wine).toMatchObject({ sweetness_category: 'dry', sweetness_category_basis: 'tier' });
      const port = await tool('get_bottle', { bottle_id: String(bottles.port._id) });
      expect(port.data.wine).toMatchObject({ sweetness_category: null, sweetness_category_basis: null });
    });
  });
});
