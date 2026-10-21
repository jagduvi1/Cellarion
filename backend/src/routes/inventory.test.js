/**
 * GET /api/inventory end to end: the real router, the real requireAuth and
 * API-token scope check, the real inventory service and personal-data
 * visibility — over an in-memory stand-in for MongoDB that applies each
 * query's filter, projection and populate the way Mongo does for the shapes
 * used here. So "another user's cellar never appears" and "the heavy fields
 * are never loaded" are answered by what the queries actually ask for.
 *
 * WHY THIS TEST EXISTS:
 * Home Assistant polls this with a `read` API token. It must return exactly
 * the caller's own and shared cellars (the offline snapshot's scope), only
 * bottles still in them, personal data by the bottle page's rules, and none
 * of the heavy or internal fields; answer an unchanged poll 304 without
 * building; refuse every other token scope; and never touch anything that
 * spends AI money (Johan, 2026-10-21).
 */
process.env.JWT_SECRET = 'test-secret';

// Anything that can spend AI money (or reach Meilisearch) records being loaded.
const mockAiLoaded = [];
jest.mock('../services/aiProvider', () => { mockAiLoaded.push('aiProvider'); return {}; });
jest.mock('../services/aiChat', () => { mockAiLoaded.push('aiChat'); return {}; });
jest.mock('../services/embedding', () => { mockAiLoaded.push('embedding'); return {}; });
jest.mock('../services/embeddingJob', () => { mockAiLoaded.push('embeddingJob'); return {}; });
jest.mock('../services/enrichmentJob', () => { mockAiLoaded.push('enrichmentJob'); return {}; });
jest.mock('../services/labelScan', () => { mockAiLoaded.push('labelScan'); return {}; });
jest.mock('../services/search', () => { mockAiLoaded.push('search'); return {}; });
jest.mock('../services/vectorStore', () => { mockAiLoaded.push('vectorStore'); return {}; });
jest.mock('meilisearch', () => { mockAiLoaded.push('meilisearch'); return {}; });

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/ApiToken', () => {
  const crypto = require('crypto');
  return {
    findOne: jest.fn(),
    updateOne: jest.fn(() => ({ catch: () => {} })),
    hashToken: (raw) => crypto.createHash('sha256').update(raw).digest('hex'),
    TOKEN_PREFIX: 'cel_',
  };
});
jest.mock('../models/User', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PersonalDataEntry', () => ({ find: jest.fn() }));
// routes/cellars is heavy and only lends its image resolver (as in offline.test).
jest.mock('./cellars', () => ({ attachBottleImageUrls: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const PersonalDataEntry = require('../models/PersonalDataEntry');
const { attachBottleImageUrls } = require('./cellars');
const { bumpDataVersion } = require('../services/dataVersion');
const inventoryRouter = require('./inventory');

// ── Fixture ──────────────────────────────────────────────────────────────
const id = (n) => `64b0000000000000000000${n}`;
const ME = id('a1');
const FRIEND = id('a2');   // owns a cellar shared with ME (viewer)
const STRANGER = id('a3'); // shares nothing with ME
const MEMBER = id('a4');   // editor in ME's cellar

const USERS = [
  { _id: ME, username: 'johan', email: 'johan@example.com', roles: ['user'], plan: 'free' },
  { _id: FRIEND, username: 'friend', email: 'friend@example.com', roles: ['user'], plan: 'free' },
  { _id: STRANGER, username: 'stranger', email: 'stranger@example.com', roles: ['user'], plan: 'free' },
  { _id: MEMBER, username: 'maria', email: 'maria@example.com', roles: ['user'], plan: 'free' },
];
const C_OWN = id('c1');
const C_SHARED = id('c2');
const C_STRANGER = id('c3');
const C_DELETED = id('c4');
const CELLARS = [
  { _id: C_OWN, name: 'Home', user: ME, members: [{ user: MEMBER, role: 'editor', invitedEmail: 'maria@example.com' }], deletedAt: null, userColors: [] },
  { _id: C_SHARED, name: 'Friend cellar', user: FRIEND, members: [{ user: ME, role: 'viewer' }], deletedAt: null },
  { _id: C_STRANGER, name: 'Secret', user: STRANGER, members: [], deletedAt: null },
  { _id: C_DELETED, name: 'Old', user: ME, members: [], deletedAt: new Date('2026-01-01') },
];
const COUNTRIES = [{ _id: id('f1'), name: 'Italy', description: 'Long country text' }];
const REGIONS = [{ _id: id('f2'), name: 'Piedmont', description: 'Long region text' }];
const GRAPES = [{ _id: id('f3'), name: 'Nebbiolo', description: 'Long grape text', regionalNames: [] }];
const W1 = id('d1');
const W2 = id('d2');
const W3 = id('d3');
const WINES = [
  {
    _id: W1, name: 'Barolo', producer: 'Mascarello', type: 'red', colour: null, country: id('f1'), region: id('f2'),
    appellation: 'Barolo', classification: 'DOCG', grapes: [id('f3')], image: '/api/uploads/processed/w1img.webp',
    aiProfile: {
      body: 'full', tannin: 'high', acidity: 'high', sweetness: 'dry',
      flavors: ['tar', 'rose'], foodPairings: ['truffle'],
      description: 'SECRET-PROSE', confidence: 0.9, producerSuspect: false, producerNote: 'SECRET-NOTE',
      source: 'ai', verifiedBy: STRANGER, heldAt: null, heldReason: null,
    },
    scanImage: 'SECRET-SCAN', contribution: { instance: 'SECRET-INSTANCE' }, createdBy: STRANGER, normalizedKey: 'barolo',
  },
  {
    _id: W2, name: 'Held Wine', producer: 'Brand', type: 'white', grapes: [], image: 'https://example.com/w2.jpg',
    aiProfile: { body: null, flavors: [], heldAt: new Date('2026-08-01'), heldReason: 'producer_suspect', producerNote: 'SECRET-NOTE' },
  },
  { _id: W3, name: 'Stranger Wine', producer: 'Nobody', type: 'red', grapes: [] },
];
const REQUESTS = [{ _id: id('e1'), wineName: 'Mystery Red', producer: 'Unknown House', user: ME, labelText: 'SECRET-LABEL' }];
const HEAVY = {
  cellarHistory: [{ cellar: C_STRANGER, cellarName: 'SECRET-HISTORY', enteredAt: new Date() }],
  pours: [{ at: new Date(), ml: 125 }], barcode: '7310000000000', purchaseUrl: 'https://shop.example/SECRET',
  occasion: 'SECRET-OCCASION', consumedNote: 'SECRET-CONSUMED', reservedFor: 'SECRET-RESERVED', user: ME,
};
const B = (n) => id(`b${n}`);
const BOTTLES = [
  {
    _id: B(1), cellar: C_OWN, wineDefinition: W1, vintage: '2015', status: 'active', bottleSize: '750ml', price: 450, currency: 'SEK',
    rating: 4, ratingScale: '5', notes: 'Decant 2h', purchaseDate: new Date('2024-05-01T00:00:00Z'), purchaseLocation: 'Systembolaget',
    createdAt: new Date('2025-01-02T10:00:00Z'), openedAt: null, location: 'Basement, box 3', drinkFrom: 2024, drinkTo: 2040,
    defaultImage: null, ...HEAVY,
  },
  { _id: B(2), cellar: C_OWN, wineDefinition: W1, vintage: '2016', status: 'drank', createdAt: new Date(), ...HEAVY },
  { _id: B(3), cellar: C_OWN, wineDefinition: W2, vintage: '2020', status: 'ordered', createdAt: new Date() },
  // A legacy row with no status still counts as in the cellar.
  { _id: B(4), cellar: C_SHARED, wineDefinition: W2, vintage: '2018', createdAt: new Date('2025-03-01T00:00:00Z') },
  { _id: B(5), cellar: C_STRANGER, wineDefinition: W3, vintage: '2019', status: 'active', createdAt: new Date(), notes: 'SECRET-STRANGER' },
  { _id: B(6), cellar: C_DELETED, wineDefinition: W1, vintage: '2015', status: 'active', createdAt: new Date() },
  { _id: B(7), cellar: C_OWN, wineDefinition: null, pendingWineRequest: id('e1'), vintage: 'NV', status: 'active', createdAt: new Date() },
];
const RACKS = [
  {
    _id: id('r1'), cellar: C_OWN, user: ME, name: 'Fridge', type: 'cabinet', rows: 3, cols: 6, typeConfig: { shelfRows: [1, 2, 1] },
    slots: [{ position: 14, bottle: B(1), rfidTag: 'SECRET-RFID' }], zones: [{ name: 'SECRET-ZONE', positions: [1] }], deletedAt: null,
  },
  { _id: id('r2'), cellar: C_STRANGER, user: STRANGER, name: 'Stranger rack', type: 'grid', rows: 2, cols: 2, slots: [{ position: 1, bottle: B(5) }], deletedAt: null },
  { _id: id('r3'), cellar: C_OWN, user: ME, name: 'Deleted rack', type: 'grid', rows: 2, cols: 2, slots: [], deletedAt: new Date() },
];
const PROFILES = [
  { _id: id('p1'), wineDefinition: W2, vintage: '2018', status: 'reviewed', earlyFrom: 2020, peakFrom: 2022, peakUntil: 2026, lateUntil: 2030 },
];
const KEYS = [
  { _id: id('k1'), user: MEMBER, name: 'Closure', type: 'enum', enumOptions: ['cork', 'screw'] },
  { _id: id('k2'), user: STRANGER, name: 'ABV', type: 'decimal', unit: '%' },
];
const ENTRIES = [
  // Bottle-level by a member → visible.
  { _id: id('11'), author: MEMBER, key: id('k1'), targetType: 'bottle', bottle: B(1), value: 'cork', vintage: null },
  // Wine-level by someone in no cellar of this bottle → hidden.
  { _id: id('12'), author: STRANGER, key: id('k2'), targetType: 'wine', wineDefinition: W1, value: 15, vintage: null },
  // Wine-level by the shared cellar's owner → visible on that cellar's bottle.
  { _id: id('13'), author: FRIEND, key: id('k2'), targetType: 'wine', wineDefinition: W2, value: 12.5, vintage: null },
  // Wine-level by me for 2016 only → hidden on my 2015 bottle.
  { _id: id('14'), author: ME, key: id('k2'), targetType: 'wine', wineDefinition: W1, value: 14, vintage: '2016' },
  // On the stranger's bottle → never.
  { _id: id('15'), author: STRANGER, key: id('k2'), targetType: 'bottle', bottle: B(5), value: 13, vintage: null },
];

// ── A small stand-in for Mongo: filter, inclusion projection, populate ──
const sid = (v) => (v && typeof v === 'object' && !(v instanceof Date) && v._id !== undefined ? String(v._id) : v == null ? v : String(v));
function valuesAt(doc, path) {
  let cur = [doc];
  for (const part of path.split('.')) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      const v = c[part];
      if (Array.isArray(v)) next.push(...v);
      else if (v !== undefined) next.push(v);
    }
    cur = next;
  }
  return cur;
}
function matches(doc, query) {
  return Object.entries(query).every(([field, cond]) => {
    if (field === '$or') return cond.some((arm) => matches(doc, arm));
    const vals = valuesAt(doc, field);
    if (cond === null) return vals.length === 0 || vals.some((v) => v == null);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if (cond.$in) return vals.some((v) => cond.$in.map(sid).includes(sid(v)));
      if (cond.$nin) return vals.every((v) => !cond.$nin.map(sid).includes(sid(v)));
      throw new Error(`unsupported condition ${JSON.stringify(cond)}`);
    }
    return vals.some((v) => sid(v) === sid(cond));
  });
}
function pick(src, parts, dst) {
  const [head, ...rest] = parts;
  if (src == null || !(head in src)) return;
  const v = src[head];
  if (rest.length === 0) { dst[head] = v; return; }
  if (Array.isArray(v)) {
    const arr = dst[head] || (dst[head] = v.map(() => ({})));
    v.forEach((el, i) => { if (el && typeof el === 'object') pick(el, rest, arr[i]); });
  } else if (v && typeof v === 'object') {
    pick(v, rest, dst[head] || (dst[head] = {}));
  }
}
const loads = []; // every projection asked for, by collection
function project(doc, select, coll) {
  if (!select) { loads.push([coll, '(everything)']); return doc; }
  loads.push([coll, select]);
  const out = { _id: doc._id };
  for (const p of select.split(/\s+/).filter(Boolean)) {
    if (p.startsWith('-')) throw new Error(`the stand-in supports inclusion projections only (${coll}: ${p})`);
    pick(doc, p.split('.'), out);
  }
  return out;
}
const REFS = {
  wineDefinition: ['wines', WINES], pendingWineRequest: ['wineRequests', REQUESTS], country: ['countries', COUNTRIES],
  region: ['regions', REGIONS], grapes: ['grapes', GRAPES], key: ['personalDataKeys', KEYS], author: ['users', USERS],
};
function populate(rows, spec, selectArg) {
  const specs = Array.isArray(spec) ? spec : typeof spec === 'string' ? [{ path: spec, select: selectArg }] : [spec];
  return rows.map((row) => {
    const out = { ...row };
    for (const s of specs) {
      const [coll, docs] = REFS[s.path];
      const resolve = (ref) => {
        const found = docs.find((d) => String(d._id) === sid(ref));
        if (!found) return null;
        const doc = project(structuredClone(found), s.select, coll);
        return s.populate ? populate([doc], s.populate)[0] : doc;
      };
      const v = out[s.path];
      if (Array.isArray(v)) out[s.path] = v.map(resolve).filter(Boolean);
      else if (v != null) out[s.path] = resolve(v);
    }
    return out;
  });
}
function fakeFind(coll, docs) {
  return (query = {}) => {
    const rows = docs.filter((d) => matches(d, query));
    let select = null;
    const pops = [];
    const q = {
      select: (s) => { select = s; return q; },
      populate: (spec, s2) => { pops.push([spec, s2]); return q; },
      sort: () => q,
      lean: async () => {
        let out = rows.map((r) => project(structuredClone(r), select, coll));
        for (const [spec, s2] of pops) out = populate(out, spec, s2);
        return out;
      },
    };
    return q;
  };
}

// ── Tokens ───────────────────────────────────────────────────────────────
const TOKENS = {};
function token(name, user, scopes, extra = {}) {
  const raw = `cel_${name.padEnd(64, '0')}`;
  TOKENS[ApiToken.hashToken(raw)] = { _id: id(`t${Object.keys(TOKENS).length}`), user, scopes, revokedAt: null, lastUsedAt: new Date(), ...extra };
  return raw;
}
const READ = token('read', ME, ['read']);
const READ_CONSUME = token('both', ME, ['read', 'consume']);
const CONSUME = token('consume', ME, ['consume']);
const OAUTH = token('oauth', ME, ['read'], { origin: 'oauth', expiresAt: new Date(Date.now() + 3600e3) });
const MEMBER_READ = token('member', MEMBER, ['read']);

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use('/api/inventory', inventoryRouter);
  server = http.createServer(app);
  server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  loads.length = 0;
  ApiToken.findOne.mockImplementation(async (q) => TOKENS[q.tokenHash] || null);
  User.findById.mockImplementation((uid) => ({ select: async () => USERS.find((u) => u._id === String(uid)) || null }));
  User.find.mockImplementation(fakeFind('users', USERS));
  Cellar.find.mockImplementation(fakeFind('cellars', CELLARS));
  Bottle.find.mockImplementation(fakeFind('bottles', BOTTLES));
  Rack.find.mockImplementation(fakeFind('racks', RACKS));
  WineDefinition.find.mockImplementation(fakeFind('wines', WINES));
  WineVintageProfile.find.mockImplementation(fakeFind('profiles', PROFILES));
  PersonalDataEntry.find.mockImplementation(fakeFind('personalDataEntries', ENTRIES));
  // The cellar list's resolver: the bottle's own photo on B1, nothing else.
  attachBottleImageUrls.mockImplementation(async (bottles) => bottles.map((b) => ({
    ...b,
    defaultImageUrl: String(b._id) === B(1) ? '/api/uploads/processed/b1own.webp' : null,
    pendingImageUrl: null, vintageImageUrl: null, otherVintageImageUrl: null,
  })));
});

const get = (auth, headers = {}) => fetch(`${base}/api/inventory`, {
  headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
});

describe('a read token gets the inventory', () => {
  test('200, a JSON object, never cacheable, with an ETag', async () => {
    const res = await get(READ);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ schema: 1 }));
    expect(Array.isArray(body)).toBe(false);
    expect(Object.keys(body)).toEqual(['schema', 'generatedAt', 'cellars', 'racks', 'wines', 'bottles']);
    expect(attachBottleImageUrls).toHaveBeenCalledWith(expect.any(Array), ME);
  });

  test('my cellars and the ones shared with me, with my role — never a stranger\'s, never a deleted one', async () => {
    const body = await (await get(READ)).json();
    expect(body.cellars).toEqual([
      { id: C_OWN, name: 'Home', role: 'owner' },
      { id: C_SHARED, name: 'Friend cellar', role: 'viewer' },
    ]);
    expect(body.racks).toEqual([{ id: id('r1'), cellar: C_OWN, name: 'Fridge' }]);
    expect(Object.keys(body.wines).sort()).toEqual([W1, W2].sort());
    const text = JSON.stringify(body);
    for (const leak of [C_STRANGER, C_DELETED, B(5), B(6), W3, 'Secret', 'Stranger', 'SECRET-STRANGER', id('r2'), id('r3')]) {
      expect(text).not.toContain(leak);
    }
  });

  test('only bottles still in the cellar: drunk and on-order bottles are left out, a legacy row without status counts', async () => {
    const body = await (await get(READ)).json();
    expect(body.bottles.map((b) => b.id).sort()).toEqual([B(1), B(4), B(7)].sort());
  });

  test('one bottle and one wine, field by field', async () => {
    const body = await (await get(READ)).json();
    const b1 = body.bottles.find((b) => b.id === B(1));
    expect(b1).toEqual({
      id: B(1), wine: W1, pending: null, cellar: C_OWN, vintage: '2015', size: '750ml', price: 450, currency: 'SEK',
      rating: 4, ratingScale: '5', notes: 'Decant 2h', purchaseDate: '2024-05-01', purchaseLocation: 'Systembolaget',
      addedAt: '2025-01-02T10:00:00.000Z', opened: false,
      maturity: 'peak',
      window: { drinkFrom: 2024, peakFrom: null, peakUntil: null, drinkTo: 2040 },
      location: { rack: id('r1'), rackName: 'Fridge', position: 14, shelf: 2, row: 2, col: 2 },
      place: 'Basement, box 3',
      image: '/api/uploads/thumbs/processed/b1own.webp.webp',
      personal: [{ key: 'Closure', type: 'enum', unit: null, value: 'cork', level: 'bottle', by: 'maria' }],
    });
    expect(body.wines[W1]).toEqual({
      name: 'Barolo', producer: 'Mascarello', type: 'red', colour: null, country: 'Italy', region: 'Piedmont',
      appellation: 'Barolo', classification: 'DOCG', grapes: ['Nebbiolo'],
      image: '/api/uploads/thumbs/processed/w1img.webp.webp',
      profile: { body: 'full', acidity: 'high', sweetness: 'dry', tannin: 'high', flavors: ['tar', 'rose'], foodPairings: ['truffle'] },
    });
  });

  test('the shared cellar\'s bottle: the curated window, a held profile is null, an external image is null', async () => {
    const body = await (await get(READ)).json();
    const b4 = body.bottles.find((b) => b.id === B(4));
    expect(b4).toMatchObject({
      cellar: C_SHARED, wine: W2, location: null, place: null, image: null,
      window: { drinkFrom: 2020, peakFrom: 2022, peakUntil: 2026, drinkTo: 2030 },
    });
    expect(b4.maturity).toEqual(expect.any(String));
    expect(body.wines[W2].profile).toBeNull();
    expect(body.wines[W2].image).toBeNull();
  });

  test('a bottle waiting on its wine request', async () => {
    const body = await (await get(READ)).json();
    expect(body.bottles.find((b) => b.id === B(7))).toMatchObject({
      wine: null, pending: { name: 'Mystery Red', producer: 'Unknown House' }, vintage: 'NV',
    });
  });

  test('personal data by the bottle page\'s rules', async () => {
    const body = await (await get(READ)).json();
    const personal = (bid) => body.bottles.find((b) => b.id === bid).personal;
    // B1: the member's bottle-level entry; not the stranger's wine-level one,
    // not my own 2016-only one on this 2015 bottle.
    expect(personal(B(1))).toEqual([{ key: 'Closure', type: 'enum', unit: null, value: 'cork', level: 'bottle', by: 'maria' }]);
    // B4 (shared): the cellar owner's wine-level entry.
    expect(personal(B(4))).toEqual([{ key: 'ABV', type: 'decimal', unit: '%', value: 12.5, level: 'wine', by: 'friend' }]);
    expect(personal(B(7))).toEqual([]);
  });

  test('nothing heavy or internal is loaded, let alone sent', async () => {
    const res = await get(READ);
    const text = await res.text();
    for (const word of [
      'cellarHistory', 'pours', 'barcode', 'purchaseUrl', 'occasion', 'reservedFor', 'consumedNote', 'rfidTag', 'zones',
      'SECRET', 'description', 'confidence', 'producerSuspect', 'producerNote', 'heldReason', 'verifiedBy', 'heldAt',
      'aiProfile', 'scanImage', 'contribution', 'createdBy', 'normalizedKey', 'email', 'members', 'invitedEmail',
    ]) {
      expect(text).not.toContain(word);
    }
    // …and not loaded: every query of the build named its fields.
    const bottleLoads = loads.filter(([c]) => c === 'bottles').map(([, s]) => s);
    expect(bottleLoads.length).toBeGreaterThan(0);
    for (const s of bottleLoads) {
      for (const heavy of ['cellarHistory', 'pours', 'barcode', 'purchaseUrl']) expect(s).not.toContain(heavy);
    }
    // The one whole-row read is maturityUtils.buildProfileMap's (the reviewed
    // drink windows, shared with the cellar list) — no bottle, wine or
    // personal-data row is ever read whole.
    expect([...new Set(loads.filter(([, s]) => s === '(everything)').map(([c]) => c))]).toEqual(['profiles']);
    const wineLoads = loads.filter(([c]) => c === 'wines').map(([, s]) => s).join(' ');
    expect(wineLoads).not.toMatch(/description|producerNote|producerSuspect|heldReason|source|verifiedBy|scanImage/);
  });

  test('a token with read AND consume works the same', async () => {
    expect((await get(READ_CONSUME)).status).toBe(200);
  });

  test('a normal web session works too', async () => {
    const session = jwt.sign({ id: ME, roles: ['user'] }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    const res = await get(session);
    expect(res.status).toBe(200);
    expect((await res.json()).cellars).toHaveLength(2);
  });
});

describe('conditional requests', () => {
  test('the tag of an unchanged copy answers 304 and builds nothing', async () => {
    const first = await get(READ);
    const tag = first.headers.get('etag');
    jest.clearAllMocks();
    Cellar.find.mockImplementation(fakeFind('cellars', CELLARS));
    ApiToken.findOne.mockImplementation(async (q) => TOKENS[q.tokenHash] || null);
    User.findById.mockImplementation((uid) => ({ select: async () => USERS.find((u) => u._id === String(uid)) || null }));

    const res = await get(READ, { 'If-None-Match': tag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(tag);
    expect(await res.text()).toBe('');
    expect(Bottle.find).not.toHaveBeenCalled();
    expect(Rack.find).not.toHaveBeenCalled();
    expect(PersonalDataEntry.find).not.toHaveBeenCalled();
    expect(attachBottleImageUrls).not.toHaveBeenCalled();
  });

  test('a change in a cellar I can see moves the tag, and the next poll rebuilds', async () => {
    const tag = (await get(READ)).headers.get('etag');
    bumpDataVersion(FRIEND); // e.g. the shared cellar's owner wrote a personal-data entry
    const res = await get(READ, { 'If-None-Match': tag });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(tag);
  });

  test('an offline-snapshot tag never matches (its own tag space)', async () => {
    const { snapshotTag } = require('../services/offlineSnapshot');
    const snapTag = await snapshotTag(ME);
    const res = await get(READ, { 'If-None-Match': snapTag });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(snapTag);
  });
});

describe('who may not', () => {
  test('a consume-only token → 403, and nothing is read', async () => {
    const res = await get(CONSUME);
    expect(res.status).toBe(403);
    expect(Cellar.find).not.toHaveBeenCalled();
  });

  test('an OAuth (connected AI) token → 403: its audience is the MCP endpoint only', async () => {
    expect((await get(OAUTH)).status).toBe(403);
  });

  test('no credentials → 401; an unknown token → 401', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get(`cel_${'f'.repeat(64)}`)).status).toBe(401);
  });

  test('only GET: the path takes no writes', async () => {
    const res = await fetch(`${base}/api/inventory`, { method: 'POST', headers: { Authorization: `Bearer ${READ}` } });
    expect(res.status).toBe(404);
  });
});

test('the per-user limiter: 60 per 10 minutes, 304s included', async () => {
  const first = await get(MEMBER_READ);
  expect(first.status).toBe(200);
  const tag = first.headers.get('etag');
  for (let i = 0; i < 59; i += 1) {
    const r = await get(MEMBER_READ, { 'If-None-Match': tag });
    expect(r.status).toBe(304);
  }
  const over = await get(MEMBER_READ, { 'If-None-Match': tag });
  expect(over.status).toBe(429);
  // Another user is not affected.
  expect((await get(READ)).status).toBe(200);
});

test('nothing on this path loads anything that can spend AI money or reach Meilisearch', () => {
  expect(mockAiLoaded).toEqual([]);
});
