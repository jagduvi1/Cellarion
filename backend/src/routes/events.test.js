/**
 * GET /api/events/stream (docs/ha-push-events.md §1).
 *
 * WHY THIS TEST EXISTS:
 * The SSE endpoint is the app's first long-lived response. It must (a) demand
 * auth, (b) speak the exact wire contract the Home Assistant client parses
 * (headers, retry hint, ready frame), (c) enforce the per-user stream cap with
 * 429, (d) deliver emitted events, and (e) unregister on disconnect so caps
 * don't leak.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/ApiToken', () => ({
  findOne: jest.fn(),
  hashToken: () => 'x',
  TOKEN_PREFIX: 'cel_',
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const eventBus = require('../services/eventBus');
const eventsRouter = require('./events');

let server, port;
beforeAll((done) => {
  const app = express();
  app.use('/api/events', eventsRouter);
  server = http.createServer(app);
  server.listen(0, () => { port = server.address().port; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

const token = (id = 'u1') =>
  jwt.sign({ id, roles: ['user'] }, process.env.JWT_SECRET, { algorithm: 'HS256' });

// Open a raw streaming GET; resolve with status/headers and a handle that can
// await body chunks and destroy the socket.
const openStream = (headers = {}) => new Promise((resolve, reject) => {
  const req = http.get(
    { host: '127.0.0.1', port, path: '/api/events/stream', headers },
    (res) => {
      const chunks = [];
      const waiters = [];
      res.on('data', (c) => {
        chunks.push(c.toString());
        waiters.splice(0).forEach(w => w());
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        body: () => chunks.join(''),
        nextChunk: () => new Promise(resolveWait => {
          const safety = setTimeout(resolveWait, 4000); // never hang the suite
          waiters.push(() => { clearTimeout(safety); resolveWait(); });
        }),
        destroy: () => req.destroy(),
      });
    }
  );
  req.on('error', reject);
});

afterEach(() => {
  // Any stream a test left open would leak into the next one
  eventBus.dropUser('u1');
  eventBus.dropUser('u2');
});

describe('GET /api/events/stream', () => {
  test('rejects without auth (401), stream not registered', async () => {
    const s = await openStream();
    expect(s.status).toBe(401);
    expect(eventBus.streamCounts().total).toBe(0);
  });

  test('opens with the SSE contract: headers, retry hint, ready frame', async () => {
    const s = await openStream({ Authorization: `Bearer ${token()}` });
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(s.headers['cache-control']).toContain('no-transform');
    expect(s.headers['x-accel-buffering']).toBe('no');

    if (!s.body().includes('event: ready')) await s.nextChunk();
    expect(s.body()).toContain('retry: 5000');
    expect(s.body()).toContain('event: ready\ndata: {}');
    expect(eventBus.streamCounts().total).toBe(1);
    s.destroy();
  });

  test('delivers emitted events to the connected user only', async () => {
    const s = await openStream({ Authorization: `Bearer ${token('u1')}` });
    if (!s.body().includes('event: ready')) await s.nextChunk();

    eventBus.emit('u2', 'stats_changed', { reason: 'not-yours' });
    eventBus.emit('u1', 'stats_changed', { reason: 'bottle.add' });
    // debounce window (2s) + delivery
    await s.nextChunk();
    expect(s.body()).toContain('event: stats_changed\ndata: {"reason":"bottle.add"}');
    expect(s.body()).not.toContain('not-yours');
    s.destroy();
  }, 10000);

  test('over the per-user cap → 429', async () => {
    // Fill the user's cap with dummy registrations (cheaper than 5 sockets)
    const dummies = Array.from({ length: eventBus.MAX_STREAMS_PER_USER }, () => ({
      destroyed: false, writableEnded: false, write() {}, end() { this.writableEnded = true; },
    }));
    dummies.forEach(d => eventBus.register('u1', d));

    const s = await openStream({ Authorization: `Bearer ${token('u1')}` });
    expect(s.status).toBe(429);
  });

  test('a socket that died DURING auth is reaped immediately (close already fired)', async () => {
    // Simulate the API-token auth path: requireAuth awaits DB lookups, the
    // client aborts meanwhile, so req 'close' fires before the handler attaches
    // its listener. Invoke the handler directly with an already-destroyed pair —
    // the registration must not survive, or five flaky connects would fill the
    // user's cap with zombies (permanent 429).
    const handler = eventsRouter.stack
      .find(l => l.route?.path === '/stream').route.stack.at(-1).handle;

    const req = {
      user: { id: 'u1' },
      destroyed: true,           // socket already gone
      on: () => {},              // 'close' will never fire again
    };
    const res = {
      destroyed: true,
      writableEnded: false,
      set() {}, flushHeaders() {}, write() {}, end() { this.writableEnded = true; },
      status() { return this; }, json() { return this; },
    };

    handler(req, res);
    expect(eventBus.streamCounts().total).toBe(0);
  });

  test('disconnect unregisters the stream (caps do not leak)', async () => {
    const s = await openStream({ Authorization: `Bearer ${token()}` });
    if (!s.body().includes('event: ready')) await s.nextChunk();
    expect(eventBus.streamCounts().total).toBe(1);

    s.destroy();
    await new Promise(r => setTimeout(r, 100)); // let the close event fire
    expect(eventBus.streamCounts().total).toBe(0);
  });
});
