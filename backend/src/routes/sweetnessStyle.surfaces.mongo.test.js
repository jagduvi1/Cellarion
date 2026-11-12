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
 * is gone, once answered 500 — also on a bottle update that had already been
 * saved. A wine loaded with the style's populate must still save, and an
 * admin must not delete a term a wine carries as its style. Mocked models
 * cannot show any of this, which is why it runs on MongoDB.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_style`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'style-surfaces-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'style-meili-key-0123456789abcdef';
process.env.MEILI_URL = 'http://127.0.0.1:1';

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
  let server; let base; let world; let tokens; let ops; let WineDefinition; let Bottle; let SweetnessTerm;

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
    const admin = await User.create({ username: 'root', email: 'root@contract.test', password: 'Contract-Test-Passw0rd!', roles: ['user', 'admin', 'somm'] });
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
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60000);

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
      if (state === 'warm') await ops.loadTerms(); else ops.invalidateSweetnessCache();
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
        if (state === 'warm') await ops.loadTerms(); else ops.invalidateSweetnessCache();
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
    ops.invalidateSweetnessCache();
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
});
