/**
 * Idempotent writes (#1355) — a write resent with the same Idempotency-Key is
 * applied once; the repeat gets the first answer back. The offline queue
 * depends on this: in a dead zone the request often arrives while the reply
 * doesn't, and the queue sends it again.
 */
const express = require('express');
const http = require('http');

// In-memory stand-in for the model, enforcing the unique (user, key) index.
const mockRows = new Map();
const mockKeyOf = (q) => `${q.user}|${q.key}`;
jest.mock('../models/IdempotencyRecord', () => ({
  create: jest.fn(async (doc) => {
    const k = mockKeyOf(doc);
    if (mockRows.has(k)) { const e = new Error('dup'); e.code = 11000; throw e; }
    const row = { _id: k, status: null, body: null, createdAt: new Date(), ...doc };
    mockRows.set(k, row);
    return row;
  }),
  findOne: jest.fn((q) => ({ lean: async () => (mockRows.has(mockKeyOf(q)) ? { ...mockRows.get(mockKeyOf(q)) } : null) })),
  updateOne: jest.fn(async ({ _id }, { $set }) => { if (mockRows.has(_id)) Object.assign(mockRows.get(_id), $set); }),
  deleteOne: jest.fn(async ({ _id, status }) => {
    const r = mockRows.get(_id);
    if (r && (status === undefined || r.status === status)) mockRows.delete(_id);
  }),
}));

const { idempotency, STALE_MS } = require('./idempotency');

let applied;
let server;
let base;
let failNext;
let slow;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: req.get('X-Test-User') || 'u1' }; next(); });
  app.use(idempotency);
  app.post('/api/bottles/:id/consume', async (req, res) => {
    if (slow) await slow;
    if (failNext) { failNext = false; return res.status(500).json({ error: 'boom' }); }
    applied++;
    res.json({ bottle: { _id: req.params.id, status: 'drank', n: applied } });
  });
  app.put('/api/racks/:id/slots/:pos', (req, res) => { applied++; res.status(409).json({ error: 'Slot taken' }); });
  app.get('/api/bottles/:id', (req, res) => res.json({ ok: true }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { mockRows.clear(); applied = 0; failNext = false; slow = null; });

const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const send = (path, { key = KEY, method = 'POST', user } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}), ...(user ? { 'X-Test-User': user } : {}) },
  body: method === 'GET' ? undefined : '{}',
});
const flush = () => new Promise((r) => setTimeout(r, 20));

test('a repeat gets the first answer back and the write runs once', async () => {
  const a = await send('/api/bottles/b1/consume');
  await flush();
  const b = await send('/api/bottles/b1/consume');
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(await b.json()).toEqual({ bottle: { _id: 'b1', status: 'drank', n: 1 } });
  expect(b.headers.get('idempotent-replayed')).toBe('true');
  expect(applied).toBe(1);
});

test('a rejected write replays its rejection (4xx is an outcome)', async () => {
  await send('/api/racks/r1/slots/3', { method: 'PUT' });
  await flush();
  const again = await send('/api/racks/r1/slots/3', { method: 'PUT' });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: 'Slot taken' });
  expect(applied).toBe(1);
});

test('a 5xx is not stored: the retry runs for real', async () => {
  failNext = true;
  expect((await send('/api/bottles/b1/consume')).status).toBe(500);
  await flush();
  const retry = await send('/api/bottles/b1/consume');
  expect(retry.status).toBe(200);
  expect(retry.headers.get('idempotent-replayed')).toBeNull();
  expect(applied).toBe(1);
});

test('a repeat while the first is still running is told to retry', async () => {
  let release;
  slow = new Promise((r) => { release = r; });
  const first = send('/api/bottles/b1/consume');
  await flush();
  const second = await send('/api/bottles/b1/consume');
  expect(second.status).toBe(409);
  expect(second.headers.get('retry-after')).toBe('2');
  release();
  expect((await first).status).toBe(200);
  expect(applied).toBe(1);
});

test('an abandoned in-progress record is freed after STALE_MS', async () => {
  mockRows.set(`u1|${KEY}`, { _id: `u1|${KEY}`, user: 'u1', key: KEY, method: 'POST', path: '/api/bottles/b1/consume', status: null, createdAt: new Date(Date.now() - STALE_MS - 1000) });
  const res = await send('/api/bottles/b1/consume');
  expect(res.status).toBe(200);
  expect(applied).toBe(1);
});

test('the same key for a different request is refused', async () => {
  await send('/api/bottles/b1/consume');
  await flush();
  const other = await send('/api/bottles/b2/consume');
  expect(other.status).toBe(422);
  expect(applied).toBe(1);
});

test('keys are per user: another account never sees the stored answer', async () => {
  await send('/api/bottles/b1/consume');
  await flush();
  const theirs = await send('/api/bottles/b1/consume', { user: 'u2' });
  expect(theirs.headers.get('idempotent-replayed')).toBeNull();
  expect(applied).toBe(2);
});

test('without the header, and for GET, nothing changes', async () => {
  await send('/api/bottles/b1/consume', { key: null });
  await send('/api/bottles/b1/consume', { key: null });
  expect(applied).toBe(2);
  expect((await send('/api/bottles/b1', { method: 'GET' })).status).toBe(200);
  expect(mockRows.size).toBe(0);
});

test('a malformed key is refused', async () => {
  expect((await send('/api/bottles/b1/consume', { key: 'short' })).status).toBe(400);
  expect((await send('/api/bottles/b1/consume', { key: 'x'.repeat(20) + '/..' })).status).toBe(400);
  expect(applied).toBe(0);
});
