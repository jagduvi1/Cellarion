/**
 * The public API keeps its promises: every operation in openapi/document.js,
 * called on the REAL app (app.js: every mount, limiter and middleware) against
 * a REAL MongoDB seeded through the models (contract.fixtures.js), answers
 * with a documented status and a body and headers that match the document.
 *
 * Coverage is by construction: the suite fails when a documented status has
 * no case below (or a case names one that is not documented), unless
 * NOT_EXERCISED gives the reason it cannot be triggered here.
 *
 * And nothing documented spends AI money: the functions that call an AI
 * provider or pay for an embedding are wrapped to record every call, with
 * the providers reported as configured so a code path that WOULD spend gets
 * as far as the call; the suite fails if any was made.
 *
 * Needs a MongoDB: CONTRACT_MONGO_URI, whose database name must start with
 * "cellarion_contract" (it is dropped before and after). CI provides one; a
 * local run without it skips the suite with a notice. Locally, against the
 * dev stack's Mongo:
 *   docker run --rm --network cellarion-main_default \
 *     -e CONTRACT_MONGO_URI=mongodb://mongo:27017/cellarion_contract_local \
 *     -v "<repo>/backend:/app" -w /app node:24-alpine \
 *     node node_modules/jest/bin/jest.js src/openapi/contract.test.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'contract-'.repeat(8);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'contract-meili-key-0123456789abcdef';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// Every call that would spend AI money, recorded.
const mockAiCalls = [];
function mockTrap(name, actual, spending, overrides = {}) {
  const out = { ...actual, ...overrides };
  for (const fn of spending) {
    out[fn] = (...args) => {
      mockAiCalls.push(`${name}.${fn}`);
      throw new Error(`contract test: ${name}.${fn} would spend AI money`);
    };
  }
  return out;
}
jest.mock('../services/aiProvider', () => mockTrap('aiProvider', jest.requireActual('../services/aiProvider'),
  ['getChatClient'], { isConfigured: () => true }));
jest.mock('../services/embedding', () => mockTrap('embedding', jest.requireActual('../services/embedding'),
  ['embed', 'embedSingle'], { isEmbeddingConfigured: () => true }));
jest.mock('../services/labelScan', () => mockTrap('labelScan', jest.requireActual('../services/labelScan'),
  ['scanLabelFull', 'scanLabelBack', 'identifyWineFromText', 'identifyWineFromQuery', 'suggestDrinkWindow', 'suggestPrice', 'suggestProfile']));
jest.mock('../services/receiptScan', () => mockTrap('receiptScan', jest.requireActual('../services/receiptScan'), ['readReceipt']));
jest.mock('../services/enrichmentJob', () => mockTrap('enrichmentJob', jest.requireActual('../services/enrichmentJob'), ['enrichWineById']));
jest.mock('../services/embeddingJob', () => mockTrap('embeddingJob', jest.requireActual('../services/embeddingJob'),
  ['embedSinglePair', 'reembedActiveVintages']));
// The Meilisearch client is ESM-only (Jest cannot load it) and no documented
// operation searches through it; a client that is never reachable.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in the contract test')); }
  },
}));

const http = require('http');
const mongoose = require('mongoose');
const { buildOpenApiDocument } = require('./document');
const { createValidator } = require('./validator');
const { seedContractData, assertContractDb } = require('./contract.fixtures');

const URI = process.env.CONTRACT_MONGO_URI;
const doc = buildOpenApiDocument({ version: require('../../package.json').version });
const v = createValidator(doc);

// Statuses a documented operation can answer that this suite cannot trigger.
const NOT_EXERCISED = {
  'getHealth 503': 'only while the process drains or has lost its database',
  'getThumbnail 200': 'needs a photo file in the uploads volume',
  'consumeBottle 429': 'the shared write limiter (express-rate-limit); getInventory 429 exercises the 429 shape',
  'ingestClimate 429': 'per-device quota and limiter; getInventory 429 exercises the 429 shape',
  'streamEvents 429': 'needs six open streams',
};

const ID_ZERO = '0123456789abcdef01234567';

let world;
let server;
let base;
const seen = new Set();

const describeWithMongo = URI ? describe : describe.skip;
if (!URI) {
  if (process.env.CI) throw new Error('CI must set CONTRACT_MONGO_URI: the API contract test needs a MongoDB');
  // eslint-disable-next-line no-console
  console.warn('openapi/contract.test.js skipped: set CONTRACT_MONGO_URI to a cellarion_contract* database to run it');
}

describeWithMongo('public API contract', () => {
  beforeAll(async () => {
    await mongoose.connect(URI);
    assertContractDb();
    await mongoose.connection.dropDatabase();
    world = await seedContractData();
    const app = require('../app');
    server = http.createServer(app).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    mockAiCalls.length = 0; // count only what the requests below cause
  }, 180000);

  afterAll(async () => {
    if (server) server.close();
    if (mongoose.connection.readyState === 1) {
      assertContractDb();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  async function call(operationId, { token, params = {}, query = '', headers = {}, body, stream = false } = {}) {
    const entry = v.operations().find((o) => o.operationId === operationId);
    if (!entry) throw new Error(`unknown operation ${operationId}`);
    const path = entry.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k]));
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${world.tokens[token].raw}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const res = await fetch(`${base}${path}${query}`, {
      method: entry.method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    const out = { status: res.status, contentType: res.headers.get('content-type'), headers: Object.fromEntries(res.headers) };
    if (stream) {
      const { value } = await res.body.getReader().read();
      out.body = new TextDecoder().decode(value);
      ctrl.abort();
    } else {
      const text = await res.text();
      out.text = text;
      try { out.body = text ? JSON.parse(text) : null; } catch { out.body = text; }
    }
    return out;
  }

  /** Call, expect the status, validate against the document, record coverage. */
  async function expectContract(operationId, status, opts) {
    const res = await call(operationId, opts);
    if (res.status !== status) {
      throw new Error(`${operationId}: expected ${status}, got ${res.status}: ${String(res.text || res.body).slice(0, 300)}`);
    }
    const errors = v.validateResponse(operationId, res);
    if (errors.length) throw new Error(`${operationId} ${status} does not match the document:\n  ${errors.join('\n  ')}`);
    // A documented operation is never on its way out.
    if (res.headers.deprecation) throw new Error(`${operationId} ${status} answered with a Deprecation header`);
    seen.add(`${operationId} ${status}`);
    return res;
  }

  const b = (name) => String(world.bottles[name]._id);

  test('server: health and this document', async () => {
    await expectContract('getHealth', 200);
    const res = await expectContract('getOpenApiDocument', 200);
    expect(res.body.info.version).toBe(doc.info.version);
    expect(res.body.paths).toEqual(doc.paths);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('inventory: 200, then 304 for its ETag, refusals', async () => {
    const first = await expectContract('getInventory', 200, { token: 'read' });
    expect(first.headers.etag).toMatch(/^W\/".+"$/);
    expect(first.headers['cache-control']).toBe('no-store');
    // The fixtures' shape: own + shared cellar, bottles still in them only.
    expect(first.body.cellars.map((c) => c.role).sort()).toEqual(['editor', 'owner']);
    const ids = first.body.bottles.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([b('b1'), b('b4'), b('bobs')]));
    expect(ids).not.toContain(b('drunk'));
    expect(ids).not.toContain(b('ordered'));
    const placed = first.body.bottles.find((x) => x.id === b('b1'));
    expect(placed.location).toMatchObject({ position: 5, shelf: 2, row: 1, col: 2 });
    expect(placed.personal).toEqual([expect.objectContaining({ key: 'Closure', value: 'cork', level: 'bottle', by: 'alice' })]);
    const wine = first.body.wines[String(world.wines.red._id)];
    expect(wine.profile).not.toHaveProperty('description');

    await expectContract('getInventory', 304, { token: 'read', headers: { 'If-None-Match': first.headers.etag } });
    await expectContract('getInventory', 401, { token: 'revoked' });
    await expectContract('getInventory', 403, { token: 'consume' });
  });

  test('inventory: the per-user limiter answers a documented 429', async () => {
    let res;
    for (let i = 0; i < 61; i += 1) {
      res = await call('getInventory', { token: 'carolRead' });
      if (res.status === 429) break;
    }
    expect(res.status).toBe(429);
    expect(v.validateResponse('getInventory', res)).toEqual([]);
    seen.add('getInventory 429');
  });

  test('event stream: opens with retry and ready', async () => {
    const res = await expectContract('streamEvents', 200, { token: 'read', headers: { Accept: 'text/event-stream' }, stream: true });
    expect(res.body.startsWith('retry: 5000\n\nevent: ready\n')).toBe(true);
    await expectContract('streamEvents', 401, { token: 'revoked', stream: false });
    await expectContract('streamEvents', 403, { token: 'consume' });
  });

  test('whoami', async () => {
    const res = await expectContract('whoAmI', 200, { token: 'read' });
    expect(res.body).toEqual({ id: String(world.users.alice._id) });
    await expectContract('whoAmI', 401, { token: 'revoked' });
    await expectContract('whoAmI', 403, { token: 'consume' });
  });

  test('cellars', async () => {
    const res = await expectContract('listCellars', 200, { token: 'read' });
    expect(res.body.cellars.map((c) => c.userRole).sort()).toEqual(['editor', 'owner']);
    await expectContract('listCellars', 401, { token: 'revoked' });
    await expectContract('listCellars', 403, { token: 'write' });
  });

  test('bottles: list, filters, one bottle', async () => {
    const page = await expectContract('listBottles', 200, { token: 'read', query: '?limit=2&offset=1' });
    expect(page.body.bottles).toMatchObject({ limit: 2, skip: 1, count: 2 });
    await expectContract('listBottles', 200, { token: 'read', query: '?maturity=late,declining' });
    await expectContract('listBottles', 200, { token: 'read', query: '?status=consumed&sort=-vintage' });
    await expectContract('listBottles', 401, { token: 'revoked' });
    await expectContract('listBottles', 403, { token: 'consume' });

    const one = await expectContract('getBottle', 200, { token: 'read', params: { bottleId: b('b1') } });
    expect(one.body.rackInfo).toMatchObject({ position: 5 });
    await expectContract('getBottle', 200, { token: 'read', params: { bottleId: b('b4') } });
    await expectContract('getBottle', 401, { token: 'revoked', params: { bottleId: b('b1') } });
    await expectContract('getBottle', 403, { token: 'consume', params: { bottleId: b('b1') } });
    await expectContract('getBottle', 404, { token: 'read', params: { bottleId: ID_ZERO } });
  });

  test('racks', async () => {
    const home = String(world.cellars.home._id);
    const res = await expectContract('listRacks', 200, { token: 'read', query: `?cellar=${home}&summary=1` });
    expect(res.body.racks.map((r) => r.type).sort()).toEqual(['cabinet', 'grid']);
    await expectContract('listRacks', 400, { token: 'read', query: `?cellar=${home}` });
    await expectContract('listRacks', 401, { token: 'revoked', query: `?cellar=${home}&summary=1` });
    await expectContract('listRacks', 403, { token: 'consume', query: `?cellar=${home}&summary=1` });
    await expectContract('listRacks', 404, { token: 'carolRead', query: `?cellar=${home}&summary=1` });
  });

  test('statistics, also for an account with no cellars', async () => {
    const res = await expectContract('getStatsOverview', 200, { token: 'read' });
    expect(res.body.stats.urgencyLadder.map((u) => u.id)).toContain(b('late'));
    await expectContract('getStatsOverview', 200, { token: 'carolRead' });
    await expectContract('getStatsOverview', 401, { token: 'revoked' });
    await expectContract('getStatsOverview', 403, { token: 'consume' });
  });

  test('notifications', async () => {
    const list = await expectContract('listNotifications', 200, { token: 'read' });
    expect(list.body.unreadCount).toBe(1);
    await expectContract('listNotifications', 401, { token: 'revoked' });
    await expectContract('listNotifications', 403, { token: 'consume' });
    const probe = await expectContract('getUnreadCount', 200, { token: 'read' });
    expect(probe.body.newestId).toBe(String(list.body.notifications[0]._id));
    await expectContract('getUnreadCount', 401, { token: 'revoked' });
    await expectContract('getUnreadCount', 403, { token: 'consume' });
  });

  test('consume: once, never twice with ifActive, refusals', async () => {
    const id = b('consumable');
    const res = await expectContract('consumeBottle', 200, {
      token: 'consume', params: { bottleId: id }, body: { reason: 'drank', rating: 4, consumedRatingScale: '5', note: 'Lovely', ifActive: true },
    });
    expect(res.body.bottle.status).toBe('drank');
    const again = await expectContract('consumeBottle', 409, { token: 'consume', params: { bottleId: id }, body: { ifActive: true } });
    expect(again.body.code).toBe('state_changed');
    await expectContract('consumeBottle', 400, { token: 'consume', params: { bottleId: b('b3') }, body: { reason: 'lost' } });
    await expectContract('consumeBottle', 401, { token: 'revoked', params: { bottleId: b('b3') }, body: {} });
    await expectContract('consumeBottle', 403, { token: 'read', params: { bottleId: b('b3') }, body: {} });
    await expectContract('consumeBottle', 404, { token: 'consume', params: { bottleId: ID_ZERO }, body: {} });
  });

  test('climate ingest', async () => {
    const res = await expectContract('ingestClimate', 202, {
      token: 'climate',
      body: { readings: [{ channel: 'fridge', type: 'temperature', value: 12.4 }, { channel: 'fridge', type: 'humidity', value: 'wet' }] },
    });
    expect(res.body).toMatchObject({ accepted: 1, rejected: 1 });
    await expectContract('ingestClimate', 400, { token: 'climate', body: { readings: [] } });
    await expectContract('ingestClimate', 401, { token: 'revoked', body: { readings: [] } });
    await expectContract('ingestClimate', 403, { token: 'read', body: { readings: [] } });
    await expectContract('ingestClimate', 404, { token: 'climateOrphan', body: { readings: [{ channel: 'a', type: 'temperature', value: 10 }] } });
  });

  test('images: an unknown thumbnail is a 404', async () => {
    await expectContract('getThumbnail', 404, { params: { folder: 'processed', file: '00000000-aaaa-4bbb-8ccc-dddddddddddd.webp.webp' } });
  });

  test('tokens: a token revokes itself; a climate token cannot', async () => {
    const res = await expectContract('revokeOwnToken', 200, { token: 'selfRevoke' });
    expect(res.body.id).toBe(String(world.tokens.selfRevoke.doc._id));
    await expectContract('revokeOwnToken', 401, { token: 'selfRevoke' });
    await expectContract('revokeOwnToken', 403, { token: 'climate' });
  });

  test('an undocumented route a token used to reach still answers, announces its end, and is counted', async () => {
    const ApiDeprecatedUse = require('../models/ApiDeprecatedUse');
    const { SUNSET } = require('../config/apiDeprecations');
    const home = String(world.cellars.home._id);
    const res = await fetch(`${base}/api/cellars/${home}/statistics`, {
      headers: { Authorization: `Bearer ${world.tokens.read.raw}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toMatch(/^@\d+$/);
    expect(res.headers.get('sunset')).toBe(SUNSET.toUTCString());
    expect(res.headers.get('link')).toMatch(/\/developers>; rel="deprecation"/);
    await new Promise((resolve) => setTimeout(resolve, 200)); // the count is fire-and-forget
    const row = await ApiDeprecatedUse.findOne({ route: 'GET /api/cellars/:id/statistics' }).lean();
    expect(row).toMatchObject({ count: 1, day: new Date().toISOString().slice(0, 10) });
    // Counts only: nothing about who.
    expect(Object.keys(row).filter((k) => k !== '_id' && k !== '__v').sort()).toEqual(['count', 'createdAt', 'day', 'route']);

    // A made-up path under a deprecated prefix answers an error and leaves
    // no row: the key is the matched route, never the requested path.
    const junk = await fetch(`${base}/api/cellars/${home}/made-up-${Date.now()}`, {
      headers: { Authorization: `Bearer ${world.tokens.read.raw}` },
    });
    expect(junk.status).toBeGreaterThanOrEqual(400);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await ApiDeprecatedUse.countDocuments()).toBe(1);
  });

  test('every documented status was exercised, or says why not', () => {
    const documented = v.operations().flatMap((o) => o.statuses.map((s) => `${o.operationId} ${s}`));
    const missing = documented.filter((k) => !seen.has(k) && !NOT_EXERCISED[k]);
    expect(missing).toEqual([]);
    expect(Object.keys(NOT_EXERCISED).filter((k) => !documented.includes(k))).toEqual([]);
    expect([...seen].filter((k) => NOT_EXERCISED[k])).toEqual([]);
  });

  test('nothing documented spent AI money', async () => {
    // A consume queues its restock check; let it run before counting.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mockAiCalls).toEqual([]);
  });
});
