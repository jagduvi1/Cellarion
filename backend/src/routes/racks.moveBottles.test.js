/**
 * POST /api/racks/:id/move-bottles — every bottle of one rack into another
 * rack of the same cellar, in order (forum feedback 2026-10-12: a rack
 * rebuilt as a wine cabinet meant moving every bottle across by hand).
 *
 * Pinned: bottles keep their order and fill the target's free positions from
 * the lowest up (taken and disabled ones skipped); with too little room the
 * first ones by position move and the rest stay; the source is written FIRST
 * (a bottle may sit in one slot only) and a refused target write puts the
 * bottles back where they were; slot rfidTags follow their bottle; editors
 * and owners only, both racks in one cellar.
 *
 * The real racks router and services/rackOps run; the models are mocked.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/Rack', () => {
  const model = { findOne: jest.fn(), find: jest.fn(), updateMany: jest.fn(), exists: jest.fn() };
  model.RACK_TYPES = ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf', 'cabinet'];
  return model;
});
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findOne: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Rack = require('../models/Rack');
const Cellar = require('../models/Cellar');
const { logAudit } = require('../services/audit');
const racksRouter = require('./racks');

jest.setTimeout(20000);

const OWNER = '64b000000000000000000001';
const VIEWER = '64b000000000000000000002';
const STRANGER = '64b000000000000000000003';
const CELLAR = '64b0000000000000000000bb';
const OTHER_CELLAR = '64b0000000000000000000bc';
const SRC = '64b0000000000000000000a1';
const DST = '64b0000000000000000000a2';
const B = (n) => `64b0000000000000000000c${n}`;

const token = (id) => jwt.sign({ id, roles: ['user'] }, 'test-secret');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/racks', racksRouter);
  return a;
}

function post(path, body, auth = token(OWNER)) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app());
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path, method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

const rackDoc = (id, over = {}) => {
  const doc = { _id: id, cellar: CELLAR, type: 'grid', rows: 2, cols: 3, disabledPositions: [], slots: [], deletedAt: null, ...over };
  doc.save = jest.fn(async () => doc);
  return doc;
};
let racks;
const slotsOf = (doc) => doc.slots.map((s) => [s.position, String(s.bottle)]).sort((a, b) => a[0] - b[0]);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  racks = {
    // Source: bottles at 5, 1 and 3 (stored out of order on purpose).
    [SRC]: rackDoc(SRC, { slots: [{ position: 5, bottle: B(3) }, { position: 1, bottle: B(1) }, { position: 3, bottle: B(2), rfidTag: 'tag-2' }] }),
    // Target, 2×3: 1 taken, 2 disabled → free 3, 4, 5, 6.
    [DST]: rackDoc(DST, { disabledPositions: [2], slots: [{ position: 1, bottle: B(9) }] }),
  };
  // Honours the cellar filter the route puts on the target lookup.
  Rack.findOne.mockImplementation(async (q) => {
    const d = racks[String(q._id)] || null;
    return d && q.cellar && String(d.cellar) !== String(q.cellar) ? null : d;
  });
  // The put-back's "is it in a rack anywhere?" read: nobody, by default.
  Rack.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  Cellar.findById.mockResolvedValue({ _id: CELLAR, user: OWNER, deletedAt: null, members: [{ user: VIEWER, role: 'viewer' }] });
});

describe('POST /api/racks/:id/move-bottles', () => {
  test("moves every bottle in order into the other rack's free slots, skipping taken and disabled ones", async () => {
    const { status, body } = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(status).toBe(200);
    expect(body).toEqual({
      moved: 3, left: 0,
      moves: [
        { bottleId: B(1), from: 1, to: 3 },
        { bottleId: B(2), from: 3, to: 4 },
        { bottleId: B(3), from: 5, to: 5 },
      ],
    });
    expect(racks[SRC].slots).toEqual([]);
    expect(slotsOf(racks[DST])).toEqual([[1, B(9)], [3, B(1)], [4, B(2)], [5, B(3)]]);
    // A slot's rfidTag follows its bottle.
    expect(racks[DST].slots.find((s) => s.position === 4).rfidTag).toBe('tag-2');
    // The source is written before the target (one slot per bottle).
    expect(racks[SRC].save.mock.invocationCallOrder[0]).toBeLessThan(racks[DST].save.mock.invocationCallOrder[0]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rack.move_bottles', expect.objectContaining({ id: DST, cellarId: CELLAR }),
      { fromRack: SRC, toRack: DST, moved: 3, left: 0 });
  });

  test('with too little room the first bottles by position move and the rest stay', async () => {
    racks[DST].slots.push({ position: 3, bottle: B(8) }, { position: 4, bottle: B(7) }); // free now: 5, 6
    const { status, body } = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(status).toBe(200);
    expect(body).toMatchObject({ moved: 2, left: 1 });
    expect(body.moves.map((m) => [m.bottleId, m.to])).toEqual([[B(1), 5], [B(2), 6]]);
    expect(slotsOf(racks[SRC])).toEqual([[5, B(3)]]);
  });

  test('a refused target write puts the bottles back where they were', async () => {
    const err = new Error('version'); err.name = 'VersionError';
    racks[DST].save.mockRejectedValueOnce(err);
    // The put-back re-reads the source as it is after step 1.
    const fresh = rackDoc(SRC, { slots: [] });
    Rack.findOne.mockImplementation(async (q) => {
      if (String(q._id) === SRC && racks[SRC].save.mock.calls.length > 0) return fresh;
      return racks[String(q._id)] || null;
    });

    const { status, body } = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(status).toBe(409);
    expect(body.code).toBe('conflict');
    expect(fresh.save).toHaveBeenCalled();
    expect(slotsOf(fresh)).toEqual([[1, B(1)], [3, B(2)], [5, B(3)]]);
    expect(fresh.slots.find((s) => s.position === 3).rfidTag).toBe('tag-2');
    expect(body.unplaced).toBeUndefined();
    // The source changed and changed back: audited, so cached layouts re-read.
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rack.move_bottles', expect.objectContaining({ id: SRC }),
      expect.objectContaining({ moved: 0, refused: true, unplaced: 0 }));
  });

  test('a bottle that cannot go back is reported as unplaced, never put in two slots', async () => {
    const err = new Error('dup'); err.code = 11000;
    racks[DST].save.mockRejectedValueOnce(err);
    // Meanwhile slot 1 of the source was taken, and B(3) was placed elsewhere.
    const fresh = rackDoc(SRC, { slots: [{ position: 1, bottle: B(7) }] });
    Rack.findOne.mockImplementation(async (q) => {
      if (String(q._id) === SRC && racks[SRC].save.mock.calls.length > 0) return fresh;
      return racks[String(q._id)] || null;
    });
    Rack.find.mockReturnValue({ select: () => ({ lean: async () => [{ slots: [{ position: 2, bottle: B(3) }] }] }) });

    const { status, body } = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(status).toBe(409);
    expect(body.unplaced).toBe(1); // B(1): its slot is taken; B(2) went back; B(3) sits elsewhere
    expect(slotsOf(fresh)).toEqual([[1, B(7)], [3, B(2)]]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rack.move_bottles', expect.anything(),
      expect.objectContaining({ refused: true, unplaced: 1 }));
  });

  test('a source changed at the same moment: nothing moves', async () => {
    const err = new Error('version'); err.name = 'VersionError';
    racks[SRC].save.mockRejectedValueOnce(err);
    const { status } = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(status).toBe(409);
    expect(racks[DST].save).not.toHaveBeenCalled();
  });

  test.each([
    ['a viewer', () => token(VIEWER), 403],
    ['someone with no access', () => token(STRANGER), 404],
  ])('refuses %s', async (_label, auth, code) => {
    const { status } = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST }, auth());
    expect(status).toBe(code);
    expect(racks[SRC].save).not.toHaveBeenCalled();
  });

  test.each([
    ['a bad target id', () => ({ toRackId: 'nope' }), 400],
    ['the same rack', () => ({ toRackId: SRC }), 400],
    ['a rack that does not exist', () => ({ toRackId: '64b0000000000000000000ff' }), 404],
  ])('refuses %s', async (_label, body, code) => {
    const { status } = await post(`/api/racks/${SRC}/move-bottles`, body());
    expect(status).toBe(code);
    expect(racks[SRC].save).not.toHaveBeenCalled();
  });

  test('a rack in another cellar reads exactly like one that does not exist', async () => {
    racks[DST].cellar = OTHER_CELLAR;
    const { status, body } = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(status).toBe(404);
    expect(body.error).toBe('Rack not found');
    expect(racks[SRC].save).not.toHaveBeenCalled();
  });

  test('refuses a full rack and an empty one', async () => {
    racks[DST].slots = [3, 4, 5, 6].map((p, i) => ({ position: p, bottle: B(i + 4) })).concat(racks[DST].slots);
    let res = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('full');

    racks[SRC].slots = [];
    res = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('empty');
  });

  test('a deleted cellar reads as not found', async () => {
    Cellar.findById.mockResolvedValue({ _id: CELLAR, user: OWNER, deletedAt: new Date() });
    const { status } = await post(`/api/racks/${SRC}/move-bottles`, { toRackId: DST });
    expect(status).toBe(404);
  });
});
