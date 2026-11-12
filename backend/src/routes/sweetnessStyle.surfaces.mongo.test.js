/**
 * The sweetness style on the REAL app against a REAL MongoDB: every surface
 * that could carry a wine, in the states a running server meets.
 *
 * WHY THIS TEST EXISTS:
 * The style is stored as { term, source, url } and must leave the server only
 * in its outgoing shape { name, band, scale, regulated, source, sourceUrl },
 * as null for a wine without one, or not at all. A read that does not handle
 * it must not send the stored shape (the path is select: false), a style
 * whose term this read cannot name is left out (never null, never a bare id),
 * and none of it may break a response: serialising a wine whose term is not
 * populated while the term table's in-memory copy is cold, or whose term row
 * is gone, must answer 200 — on a bottle update too, after its save. A read
 * that asks for the field answers null for a wine without a
 * style, a row that predates the field included, the bottle list and the
 * single bottle alike; a creation answer carries no key. The MCP reads follow
 * the same rule. A wine loaded with the style's populate must still save,
 * also when its term row is gone, and an admin must not delete a term a wine
 * carries as its style. Mocked models cannot show any of this, which is why
 * it runs on MongoDB.
 *
 * Every request stays on the test stack: FRONTEND_URL is a dead local
 * address (a route that redirects points there) and fetch follows no
 * redirect.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_style`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'style-surfaces-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'style-meili-key-0123456789abcdef';
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
const { seedContractData, assertContractDb } = require('../openapi/contract.fixtures');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_style'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('routes/sweetnessStyle.surfaces.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

const SHAPE_KEYS = ['band', 'name', 'regulated', 'scale', 'source', 'sourceUrl'].join(',');

/** Every sweetnessStyle / sweetness_style value anywhere in a body. */
function stylesIn(body, out = []) {
  if (Array.isArray(body)) { for (const x of body) stylesIn(x, out); return out; }
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body)) {
    if (k === 'sweetnessStyle' || k === 'sweetness_style') out.push(v);
    stylesIn(v, out);
  }
  return out;
}
const isShaped = (v) => v !== null && typeof v === 'object' && Object.keys(v).sort().join(',') === SHAPE_KEYS;

describeWithMongo('the sweetness style on every surface (real MongoDB)', () => {
  let server; let base; let world; let tokens; let ops; let WineDefinition; let Bottle; let SweetnessTerm; let admin; let allTools;

  beforeAll(async () => {
    await mongoose.connect(URI);
    assertContractDb();
    await mongoose.connection.dropDatabase();
    world = await seedContractData();
    ops = require('../services/sweetnessOps');
    WineDefinition = require('../models/WineDefinition');
    Bottle = require('../models/Bottle');
    SweetnessTerm = require('../models/SweetnessTerm');
    const User = require('../models/User');
    admin = await User.create({ username: 'root', email: 'root@contract.test', password: 'Contract-Test-Passw0rd!', roles: ['user', 'admin', 'somm'] });
    const { alice } = world.users;
    const { red } = world.wines;
    const db = mongoose.connection.db;
    const now = new Date();
    // A wish, a resolved wine request and a price request for the styled red.
    await db.collection('wishlistitems').insertOne({ user: alice._id, wineDefinition: red._id, vintage: '2019', priority: 'medium', status: 'wanted', createdAt: now, updatedAt: now });
    await db.collection('winerequests').insertOne({ user: alice._id, wineName: 'Château Exemple', producer: 'Château Exemple', status: 'resolved', linkedWineDefinition: red._id, createdAt: now, updatedAt: now });
    await db.collection('pricetrackingrequests').insertOne({ wineDefinition: red._id, vintage: '2015', requesters: [{ user: alice._id, requestedAt: now }], firstRequestedAt: now, createdAt: now, updatedAt: now });
    const sign = (u, roles) => jwt.sign({ id: String(u._id), roles }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    tokens = { member: sign(alice, ['user']), admin: sign(admin, ['user', 'admin', 'somm']) };
    server = http.createServer(require('../app')).listen(0);
    require('../mcp/tools');
    ({ allTools } = require('../mcp/registry'));
    // search_registry falls back to the wine text index (no Meilisearch here).
    await WineDefinition.collection.createIndex({ name: 'text', producer: 'text' });
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
  const call = async (path, { token, method = 'GET', body } = {}) => {
    ip += 1;
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        'X-Forwarded-For': `10.9.${(ip >> 8) & 255}.${ip & 255}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json };
  };

  const surfaces = () => {
    const { red } = world.wines; const { b1 } = world.bottles; const { home } = world.cellars;
    return [
      ['member', '/api/bottles'],
      ['member', `/api/bottles/${b1._id}`],
      ['member', `/api/racks?cellar=${home._id}`],
      ['member', '/api/wishlist'],
      ['member', '/api/wine-requests'],
      ['member', `/api/wines/${red._id}`],
      [null, `/api/wines/${red._id}/public`],
      ['admin', '/api/admin/wines?search=Exemple'],
      ['admin', `/api/admin/wines/${red._id}`],
      ['admin', '/api/admin/wine-requests'],
      ['admin', '/api/somm/prices/queue'],
    ];
  };

  async function sweep() {
    const found = [];
    for (const [who, path] of surfaces()) {
      const res = await call(path, { token: who ? tokens[who] : null });
      expect([path, res.status]).toEqual([path, 200]);
      for (const v of stylesIn(res.body)) found.push([path, v]);
    }
    return found;
  }

  test('warm or cold, no surface sends the stored shape, and none fails', async () => {
    for (const state of ['warm', 'cold']) {
      if (state === 'warm') await ops.loadTerms(); else ops.primeSweetnessCache(null);
      const found = await sweep();
      for (const [path, v] of found) expect([state, path, v === null || isShaped(v)]).toEqual([state, path, true]);
      // The surfaces that ask for the style carry it, in its shape.
      expect(found.some(([p, v]) => p.startsWith('/api/bottles/') && isShaped(v))).toBe(true);
      expect(found.some(([p, v]) => p === `/api/wines/${world.wines.red._id}` && isShaped(v))).toBe(true);
      // The ones that do not ask for it carry no key at all.
      for (const deny of ['/api/racks', '/api/wishlist', '/api/somm/prices/queue', '/api/wine-requests', '/api/admin/']) {
        expect(found.filter(([p]) => p.startsWith(deny))).toEqual([]);
      }
    }
  }, 120000);

  test('a style whose term row is gone: nothing fails, and the style is left out — never null', async () => {
    const db = mongoose.connection.db;
    const { red } = world.wines;
    const before = await db.collection('winedefinitions').findOne({ _id: red._id });
    await db.collection('winedefinitions').updateOne({ _id: red._id }, { $set: { 'sweetnessStyle.term': new mongoose.Types.ObjectId() } });
    try {
      for (const state of ['warm', 'cold']) {
        if (state === 'warm') await ops.loadTerms(); else ops.primeSweetnessCache(null);
        const found = await sweep();
        for (const [path, v] of found) expect([state, path, v === null || isShaped(v)]).toEqual([state, path, true]);
        const detail = await call(`/api/bottles/${world.bottles.b1._id}`, { token: tokens.member });
        expect(detail.body.bottle.wineDefinition).not.toHaveProperty('sweetnessStyle');
        // A bottle update answers with the bottle: once a 500 after the save.
        const put = await call(`/api/bottles/${world.bottles.b1._id}`, { token: tokens.member, method: 'PUT', body: { notes: `noted ${state}` } });
        expect(put.status).toBe(200);
        expect(put.body.bottle.wineDefinition).not.toHaveProperty('sweetnessStyle');
      }
    } finally {
      await db.collection('winedefinitions').updateOne({ _id: red._id }, { $set: { sweetnessStyle: before.sweetnessStyle } });
    }
  }, 120000);

  test('a wine serialised with its term not populated and the term copy cold: no throw, no key', async () => {
    ops.primeSweetnessCache(null);
    const wine = await WineDefinition.findById(world.wines.red._id).select('+sweetnessStyle');
    let json;
    expect(() => { json = JSON.parse(JSON.stringify(wine)); }).not.toThrow();
    expect(json).not.toHaveProperty('sweetnessStyle');
    const plain = await WineDefinition.findById(world.wines.red._id);
    expect(JSON.parse(JSON.stringify(plain))).not.toHaveProperty('sweetnessStyle');
    const bottle = await Bottle.findById(world.bottles.b1._id).populate('wineDefinition');
    expect(() => JSON.stringify(bottle)).not.toThrow();
  });

  test('a wine loaded with the style populate validates and saves; the stored term stays an id', async () => {
    const { WINE_POPULATE } = require('../config/constants');
    const wine = await WineDefinition.findById(world.wines.red._id).select('+sweetnessStyle')
      .populate({ path: 'sweetnessStyle.term', select: 'name band scale regulated' });
    expect(wine.sweetnessStyle.term.name).toBe('dry');
    wine.imageCredit = 'Example credit';
    await expect(wine.save()).resolves.toBeTruthy();
    const bottle = await Bottle.findById(world.bottles.b1._id).populate(WINE_POPULATE);
    bottle.wineDefinition.imageCredit = 'Example credit 2';
    await expect(bottle.wineDefinition.save()).resolves.toBeTruthy();
    const stored = await mongoose.connection.db.collection('winedefinitions').findOne({ _id: world.wines.red._id });
    expect(stored.sweetnessStyle.term).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(stored.imageCredit).toBe('Example credit 2');
  });

  test('a term a wine carries only as its style is counted and cannot be deleted or re-scaled', async () => {
    const dry = await SweetnessTerm.findOne({ name: 'dry', scale: 'still' });
    const list = await call('/api/admin/taxonomy/sweetness-terms', { token: tokens.admin });
    expect(list.status).toBe(200);
    const row = list.body.sweetnessTerms.find((t) => String(t._id) === String(dry._id));
    expect(row.wineCount).toBe(1);
    expect((await call(`/api/admin/taxonomy/sweetness-terms/${dry._id}`, { token: tokens.admin, method: 'DELETE' })).status).toBe(400);
    expect((await call(`/api/admin/taxonomy/sweetness-terms/${dry._id}`, { token: tokens.admin, method: 'PUT', body: { scale: 'sparkling', band: 'sec' } })).status).toBe(400);
    expect(await SweetnessTerm.findById(dry._id)).not.toBeNull();
  });
  // ── The asked reads, REST and MCP, for a wine without a style and for one
  // this server cannot vouch for ────────────────────────────────────────────

  const mcp = async (name, args, who = 'member') => {
    const tool = allTools().find((t) => t.name === name);
    const user = who === 'admin' ? admin : world.users.alice;
    const roles = who === 'admin' ? ['user', 'admin', 'somm'] : ['user'];
    const res = await tool.handler(args, { user: { id: String(user._id), roles }, req: { user: { id: String(user._id), roles } } });
    expect([name, res.isError || false]).toEqual([name, false]);
    return JSON.parse(res.content[0].text);
  };
  /** Every object in a body that is the wine with this id, under the given id key. */
  const winesIn = (body, id, key, out = []) => {
    if (Array.isArray(body)) { for (const x of body) winesIn(x, id, key, out); return out; }
    if (!body || typeof body !== 'object') return out;
    if (String(body[key]) === String(id) && ('producer' in body || 'name' in body)) out.push(body);
    for (const v of Object.values(body)) winesIn(v, id, key, out);
    return out;
  };
  /** The asked REST reads and MCP tools, each wine object of the given wine with its style value (undefined = no key). */
  async function askedReads(wine, bottle) {
    const seen = [];
    const rest = [
      ['/api/bottles', 'member'],
      [`/api/bottles/${bottle._id}`, 'member'],
      [`/api/cellars/${world.cellars.home._id}`, 'member'],
      [`/api/wines/${wine._id}`, 'member'],
      [`/api/wines/${wine._id}/public`, null],
    ];
    for (const [path, who] of rest) {
      const res = await call(path, { token: who ? tokens[who] : null });
      expect([path, res.status]).toEqual([path, 200]);
      const found = winesIn(res.body, wine._id, '_id');
      expect([path, found.length > 0]).toEqual([path, true]);
      for (const w of found) seen.push([path, w.sweetnessStyle]);
    }
    const put = await call(`/api/bottles/${bottle._id}`, { token: tokens.member, method: 'PUT', body: { notes: 'asked reads' } });
    expect(put.status).toBe(200);
    seen.push(['PUT /api/bottles/:id', put.body.bottle.wineDefinition.sweetnessStyle]);
    const inv = await call('/api/inventory', { token: tokens.member });
    expect(inv.status).toBe(200);
    const invWines = [];
    (function walk(b) { if (Array.isArray(b)) b.forEach(walk); else if (b && typeof b === 'object') { if (b.name === wine.name && 'labelSweetness' in b) invWines.push(b); Object.values(b).forEach(walk); } })(inv.body);
    expect(invWines.length > 0).toBe(true);
    for (const w of invWines) seen.push(['/api/inventory', w.sweetnessStyle]);
    for (const [tool, args] of [['get_wine', { wine_id: String(wine._id) }], ['get_bottle', { bottle_id: String(bottle._id) }], ['search_registry', { query: wine.name }]]) {
      const found = winesIn(await mcp(tool, args), wine._id, 'wine_id');
      expect([tool, found.length > 0]).toEqual([tool, true]);
      for (const w of found) seen.push([tool, w.sweetness_style]);
    }
    return seen;
  }

  test('a read that asks answers null for a wine without a style — a row that predates the field — on every surface alike', async () => {
    const { white } = world.wines;
    const raw = await mongoose.connection.db.collection('winedefinitions').findOne({ _id: white._id });
    expect(raw).not.toHaveProperty('sweetnessStyle');
    const seen = await askedReads(white, world.bottles.b3);
    for (const [where, v] of seen) expect([where, v]).toEqual([where, null]);
  }, 120000);

  test.each([
    ['its term row is gone', { 'sweetnessStyle.term': new mongoose.Types.ObjectId() }],
    ['a stored source the rules refuse', { 'sweetnessStyle.source': 'critic' }],
    ['a stored link without a host', { 'sweetnessStyle.url': 'https://./' }],
  ])('a style this server cannot vouch for (%s): no key on any asked read, REST or MCP — never null', async (label, set) => {
    const db = mongoose.connection.db;
    const { red } = world.wines;
    const before = await db.collection('winedefinitions').findOne({ _id: red._id });
    await db.collection('winedefinitions').updateOne({ _id: red._id }, { $set: set });
    try {
      for (const state of ['warm', 'cold']) {
        if (state === 'warm') await ops.loadTerms(); else ops.primeSweetnessCache(null);
        const seen = await askedReads(red, world.bottles.b1);
        for (const [where, v] of seen) expect([state, where, v]).toEqual([state, where, undefined]);
      }
    } finally {
      await db.collection('winedefinitions').updateOne({ _id: red._id }, { $set: { sweetnessStyle: before.sweetnessStyle } });
    }
  }, 180000);

  test('a style the server can vouch for reads the same on every asked surface', async () => {
    await ops.loadTerms();
    const seen = await askedReads(world.wines.red, world.bottles.b1);
    for (const [where, v] of seen) {
      const shaped = v && typeof v === 'object' ? { ...v } : v;
      if (shaped && 'source_url' in shaped) { shaped.sourceUrl = shaped.source_url; delete shaped.source_url; }
      expect([where, shaped]).toEqual([where, { name: 'dry', band: 'dry', scale: 'still', regulated: true, source: 'producer', sourceUrl: 'https://www.example.com/chateau-exemple/wines' }]);
    }
  }, 120000);

  test('a creation answer carries no style key, like the reads that do not ask', async () => {
    const created = await call('/api/admin/wines', { token: tokens.admin, method: 'POST', body: { name: 'Riesling Feinherb Probe', producer: 'Weingut Beispiel', country: String((await mongoose.connection.db.collection('countries').findOne({}))._id), type: 'white', confirmCreate: true } });
    expect(created.status).toBe(201);
    expect(stylesIn(created.body)).toEqual([]);
    const read = await call(`/api/admin/wines/${created.body.wine._id}`, { token: tokens.admin });
    expect(read.status).toBe(200);
    expect(stylesIn(read.body)).toEqual([]);
  });

  test('a wine whose style term row is gone still saves after the style populate; the stored term stays', async () => {
    const db = mongoose.connection.db;
    const { red } = world.wines;
    const before = await db.collection('winedefinitions').findOne({ _id: red._id });
    const gone = new mongoose.Types.ObjectId();
    await db.collection('winedefinitions').updateOne({ _id: red._id }, { $set: { 'sweetnessStyle.term': gone } });
    try {
      const wine = await WineDefinition.findById(red._id).select('+sweetnessStyle')
        .populate({ path: 'sweetnessStyle.term', select: 'name band scale regulated' });
      expect(wine.sweetnessStyle.term).toBeNull();
      wine.imageCredit = 'Example credit 3';
      await expect(wine.save()).resolves.toBeTruthy();
      const stored = await db.collection('winedefinitions').findOne({ _id: red._id });
      expect(String(stored.sweetnessStyle.term)).toBe(String(gone));
    } finally {
      await db.collection('winedefinitions').updateOne({ _id: red._id }, { $set: { sweetnessStyle: before.sweetnessStyle, imageCredit: before.imageCredit ?? null } });
    }
  });

  test('the bottle answers a member reads never carry the label-sweetness curation marks', async () => {
    const db = mongoose.connection.db;
    const { white } = world.wines;
    await db.collection('winedefinitions').updateOne({ _id: white._id }, { $set: { sweetnessInName: true, sweetnessReview: { reason: 'term_contradiction', detail: 'curation only', since: new Date() } } });
    const hidden = (body) => JSON.stringify(body).match(/"(sweetnessReview|sweetnessInName)"/g) || [];
    for (const path of ['/api/bottles', `/api/bottles/${world.bottles.b3._id}`, `/api/cellars/${world.cellars.home._id}`]) {
      const res = await call(path, { token: tokens.member });
      expect([path, res.status]).toEqual([path, 200]);
      expect([path, hidden(res.body)]).toEqual([path, []]);
    }
    const put = await call(`/api/bottles/${world.bottles.b3._id}`, { token: tokens.member, method: 'PUT', body: { notes: 'marks hidden' } });
    expect(put.status).toBe(200);
    expect(hidden(put.body)).toEqual([]);
  });
});
