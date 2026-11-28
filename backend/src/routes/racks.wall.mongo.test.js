/**
 * A wall rack through the REST routes: created, filled, and then edited while
 * in use — the REAL models on a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * utils/wallGeometry.test.js pins the plan of an edit; this pins that the
 * plan reaches everything the database numbers by a slot position. A wall
 * edit renumbers every box after the one that changed, and four things carry
 * such a number: the placed bottles, the switched-off slots, the zones, and
 * the slot an opened bottle left (on the Bottle, not on the rack). Only the
 * stored documents can show that all four moved together, that the boxes kept
 * their ids across the save, and that a refused edit changed nothing.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_rack_wall`, dropped before and after. Skipped without
 * it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rack-wall-secret-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'rack-wall-meili-key-0123456789abc';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here
// searches through it.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const mongoose = require('mongoose');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { assertContractDb } = require('../openapi/contract.fixtures');

jest.setTimeout(90000);

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_rack_wall'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('routes/racks.wall.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

describeWithMongo('a wall rack through the REST routes (real MongoDB)', () => {
  let server; let base; let token;
  let Rack; let Bottle; let user; let cellar;

  const call = async (method, path, body, root = '/api/racks') => {
    const res = await fetch(`${base}${root}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const bottle = (vintage) => Bottle.create({ user: user._id, cellar: cellar._id, wineDefinition: null, vintage });
  const stored = (id) => Rack.findById(id).lean();
  const placed = async (id) => Object.fromEntries((await stored(id)).slots.map((s) => [String(s.bottle), s.position]));

  // One row of three boxes: A1 an X of six a triangle (positions 1–24),
  // B1 a rack of 3 × 4 (25–36), C1 an open bin of ten (37–46).
  const BOXES = [
    { x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 },
    { x: 1, y: 0, w: 1, h: 1, kind: 'rack', rows: 3, cols: 4 },
    { x: 2, y: 0, w: 1, h: 1, kind: 'bin', perSection: 10 },
  ];
  const newWall = async (name) => {
    const res = await call('POST', '', { cellar: String(cellar._id), name, type: 'wall', rows: 1, cols: 3, typeConfig: { boxes: BOXES } });
    expect(res.status).toBe(201);
    return res.body.rack;
  };

  beforeAll(async () => {
    await mongoose.connect(URI);
    assertContractDb();
    await mongoose.connection.dropDatabase();
    const User = require('../models/User');
    const Cellar = require('../models/Cellar');
    Rack = require('../models/Rack');
    Bottle = require('../models/Bottle');
    await Rack.init();
    user = await User.create({ username: 'waller', email: 'waller@contract.test', password: 'Contract-Test-Passw0rd!' });
    cellar = await Cellar.create({ name: 'Cellar', user: user._id });
    token = jwt.sign({ id: String(user._id), roles: ['user'] }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/racks', require('./racks'));
    app.use('/api/bottles', require('./bottles'));
    server = http.createServer(app).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  }, 120000);

  afterAll(async () => {
    // The audit rows of the last test are written after it returns.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    if (mongoose.connection.readyState === 1) {
      assertContractDb();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('a wall is stored with its boxes, each box gets an id, and its slots are the boxes added up', async () => {
    const rack = await newWall('Bin wall');
    expect(rack.type).toBe('wall');
    expect(rack.typeConfig.boxes.map((b) => b.kind)).toEqual(['x', 'rack', 'bin']);
    for (const b of rack.typeConfig.boxes) expect(String(b._id)).toMatch(/^[0-9a-f]{24}$/);

    const b = await bottle('2015');
    expect((await call('PUT', `/${rack._id}/slots/46`, { bottleId: String(b._id) })).status).toBe(200);
    expect((await call('PUT', `/${rack._id}/slots/47`, { bottleId: String(b._id) })).status).toBe(400);
  });

  test('a wall needs its boxes, and no other rack type takes them', async () => {
    const at = { cellar: String(cellar._id), rows: 1, cols: 3 };
    const none = await call('POST', '', { ...at, name: 'No boxes', type: 'wall' });
    expect(none).toMatchObject({ status: 400, body: { error: 'boxes is required for a wall rack' } });
    const overlap = await call('POST', '', { ...at, name: 'Overlap', type: 'wall', typeConfig: { boxes: [{ ...BOXES[0], w: 2 }, BOXES[1]] } });
    expect(overlap.status).toBe(400);
    expect(overlap.body.error).toMatch(/Box B1 overlaps another box/);
    const grid = await call('POST', '', { ...at, name: 'Grid with boxes', type: 'grid', typeConfig: { boxes: BOXES } });
    expect(grid).toMatchObject({ status: 400, body: { error: 'boxes are only supported on a wall rack' } });
    expect(await Rack.countDocuments({ name: { $in: ['No boxes', 'Overlap', 'Grid with boxes'] } })).toBe(0);
  });

  test('editing a wall in use keeps bottles, switched-off slots, zones and the slot an opened bottle left in their boxes', async () => {
    const rack = await newWall('Edited wall');
    const [inX, inRack, inBin, opened] = await Promise.all(['2010', '2011', '2012', '2013'].map(bottle));
    for (const [position, b] of [[1, inX], [30, inRack], [40, inBin]]) {
      expect((await call('PUT', `/${rack._id}/slots/${position}`, { bottleId: String(b._id) })).status).toBe(200);
    }
    expect((await call('POST', `/${rack._id}/slots/45/disable`)).status).toBe(200);
    expect((await call('PUT', `/${rack._id}`, { zones: [{ name: 'Whites', color: '#88a848', positions: [37, 38] }] })).status).toBe(200);
    await Bottle.updateOne({ _id: opened._id }, { $set: { openedFromSlot: { rack: rack._id, position: 44 } } });

    // The wall gets a second row on top (shelves across all three columns),
    // the old boxes move down a row, and the X grows from six to eight a
    // triangle. New numbering: shelves 1–20, X 21–52, rack 53–64, bin 65–74.
    const before = (await stored(rack._id)).typeConfig.boxes;
    const boxes = [
      { x: 0, y: 0, w: 3, h: 1, kind: 'shelves', rows: 2, cols: 10 },
      ...before.map((b) => ({ ...b, _id: String(b._id), y: 1, ...(b.kind === 'x' ? { perSection: 8 } : {}) })),
    ];
    const res = await call('PUT', `/${rack._id}`, { rows: 2, typeConfig: { boxes } });
    expect(res.status).toBe(200);

    const after = await stored(rack._id);
    expect(await placed(rack._id)).toEqual({ [String(inX._id)]: 21, [String(inRack._id)]: 58, [String(inBin._id)]: 68 });
    expect(after.disabledPositions).toEqual([73]);
    expect(after.zones.map((z) => z.positions)).toEqual([[65, 66]]);
    expect((await Bottle.findById(opened._id).lean()).openedFromSlot.position).toBe(72);
    // The old boxes are the same boxes; the new one got an id of its own.
    const idOf = (list, kind) => String(list.find((b) => b.kind === kind)._id);
    for (const kind of ['x', 'rack', 'bin']) expect(idOf(after.typeConfig.boxes, kind)).toBe(idOf(before, kind));
    expect(idOf(after.typeConfig.boxes, 'shelves')).toMatch(/^[0-9a-f]{24}$/);
  });

  test('a box that holds a bottle cannot be removed, and the refused edit changes nothing', async () => {
    const rack = await newWall('Loaded wall');
    const b = await bottle('2016');
    await call('PUT', `/${rack._id}/slots/26`, { bottleId: String(b._id) });
    const before = await stored(rack._id);
    const boxes = before.typeConfig.boxes.filter((x) => x.kind !== 'rack').map((x) => ({ ...x, _id: String(x._id) }));

    const res = await call('PUT', `/${rack._id}`, { typeConfig: { boxes } });
    expect(res).toMatchObject({
      status: 400,
      body: { error: 'Cannot change the wall: box B1 holds 1 bottle(s) and would be removed. Move those bottles out first.' },
    });
    const after = await stored(rack._id);
    expect(after.typeConfig.boxes.map((x) => x.kind)).toEqual(['x', 'rack', 'bin']);
    expect(await placed(rack._id)).toEqual({ [String(b._id)]: 26 });

    // Once the bottle is out, the same edit goes through and the bin moves up.
    expect((await call('DELETE', `/${rack._id}/slots/26`)).status).toBe(200);
    expect((await call('PUT', `/${rack._id}`, { typeConfig: { boxes } })).status).toBe(200);
    expect((await stored(rack._id)).typeConfig.boxes.map((x) => x.kind)).toEqual(['x', 'bin']);
  });

  test('the bottle page is told the box and the spot of a bottle in a wall, and nothing of the kind for another rack', async () => {
    const wall = await newWall('Placed wall');
    const [inPile, inRack, inGrid] = await Promise.all(['2019', '2020', '2021'].map(bottle));
    await call('PUT', `/${wall._id}/slots/8`, { bottleId: String(inPile._id) });
    await call('PUT', `/${wall._id}/slots/30`, { bottleId: String(inRack._id) });
    const grid = (await call('POST', '', { cellar: String(cellar._id), name: 'Plain grid', type: 'grid', rows: 2, cols: 3 })).body.rack;
    await call('PUT', `/${grid._id}/slots/2`, { bottleId: String(inGrid._id) });

    const page = async (b) => (await call('GET', `/${b._id}`, undefined, '/api/bottles')).body.rackInfo;
    // Position 8 is the second bottle of the X's left triangle; 30 is the rack's second row, second bottle.
    expect(await page(inPile)).toMatchObject({ rackName: 'Placed wall', position: 8, wall: { box: 'A1', kind: 'x', section: 'left', slot: 2, row: null, col: null } });
    expect(await page(inRack)).toMatchObject({ position: 30, wall: { box: 'B1', kind: 'rack', section: null, slot: null, row: 2, col: 2 } });
    const plain = await page(inGrid);
    expect(plain).toMatchObject({ rackName: 'Plain grid', position: 2 });
    expect(plain).not.toHaveProperty('wall');
  });

  test('a rack in use cannot become a wall, and a wall in use cannot stop being one', async () => {
    const wall = await newWall('Stays a wall');
    const inWall = await bottle('2017');
    await call('PUT', `/${wall._id}/slots/3`, { bottleId: String(inWall._id) });
    const toGrid = await call('PUT', `/${wall._id}`, { type: 'grid', rows: 4, cols: 8, typeConfig: {} });
    expect(toGrid).toMatchObject({ status: 400, body: { error: expect.stringMatching(/cannot change to or from a wall/) } });
    // Without a new typeConfig the stored boxes would stay on a grid.
    const stale = await call('PUT', `/${wall._id}`, { type: 'grid', rows: 4, cols: 8 });
    expect(stale).toMatchObject({ status: 400, body: { error: 'boxes are only supported on a wall rack' } });

    const grid = (await call('POST', '', { cellar: String(cellar._id), name: 'Stays a grid', type: 'grid', rows: 2, cols: 3 })).body.rack;
    const inGrid = await bottle('2018');
    await call('PUT', `/${grid._id}/slots/2`, { bottleId: String(inGrid._id) });
    const toWall = await call('PUT', `/${grid._id}`, { type: 'wall', rows: 1, cols: 3, typeConfig: { boxes: BOXES } });
    expect(toWall).toMatchObject({ status: 400, body: { error: expect.stringMatching(/cannot change to or from a wall/) } });
    expect((await stored(grid._id)).type).toBe('grid');

    // An empty grid may become a wall.
    const empty = (await call('POST', '', { cellar: String(cellar._id), name: 'Becomes a wall', type: 'grid', rows: 2, cols: 3 })).body.rack;
    const became = await call('PUT', `/${empty._id}`, { type: 'wall', rows: 1, cols: 3, typeConfig: { boxes: BOXES } });
    expect(became.status).toBe(200);
    expect((await stored(empty._id)).typeConfig.boxes).toHaveLength(3);
  });
});
