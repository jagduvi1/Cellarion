/**
 * services/shutdown — what a deploy's SIGTERM does (scaling audit 2026-09-25).
 * Node as PID 1 used to ignore it, so Docker waited its 10 s and killed the
 * process mid-work. Pinned here: the order of the steps, that a request being
 * served finishes (with Connection: close) while new connections are refused,
 * that streams are ended so the server can close, the budget, a second
 * signal, and that one failing step never blocks the rest.
 */
const http = require('http');
const express = require('express');
const shutdownModule = require('./shutdown');

const { createShutdown, drainingConnectionClose, isDraining } = shutdownModule;

const quietLog = () => ({ log: jest.fn(), warn: jest.fn() });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

afterEach(() => shutdownModule._resetForTests());

test('runs the steps in order and exits 0', async () => {
  const order = [];
  const server = {
    close: jest.fn((cb) => { order.push('server.close'); setImmediate(cb); }),
    closeIdleConnections: jest.fn(),
    closeAllConnections: jest.fn(),
  };
  const exit = jest.fn();
  const shutdown = createShutdown({
    server,
    stopJobs: () => order.push('stopJobs'),
    closeStreams: () => order.push('closeStreams'),
    drains: [async () => { order.push('drain'); }],
    closeDb: async () => order.push('closeDb'),
    exit,
    log: quietLog(),
  });

  expect(isDraining()).toBe(false);
  await shutdown('SIGTERM');

  expect(order).toEqual(['stopJobs', 'server.close', 'closeStreams', 'drain', 'closeDb']);
  expect(server.closeIdleConnections).toHaveBeenCalled();
  expect(server.closeAllConnections).not.toHaveBeenCalled();
  expect(isDraining()).toBe(true);
  expect(exit).toHaveBeenCalledWith(0);
});

test('waits for work in progress (a background removal) before closing the database', async () => {
  const work = deferred();
  const closeDb = jest.fn();
  const exit = jest.fn();
  const shutdown = createShutdown({ drains: [() => work.promise], closeDb, exit, log: quietLog() });

  const done = shutdown('SIGTERM');
  await new Promise((r) => setTimeout(r, 50));
  expect(closeDb).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();

  work.resolve();
  await done;
  expect(closeDb).toHaveBeenCalled();
  expect(exit).toHaveBeenCalledWith(0);
});

test('out of budget: cuts the open connections and exits anyway', async () => {
  const server = { close: jest.fn(), closeIdleConnections: jest.fn(), closeAllConnections: jest.fn() }; // never calls back
  const exit = jest.fn();
  const log = quietLog();
  const shutdown = createShutdown({
    server, drains: [() => new Promise(() => {})], budgetMs: 150, exit, log,
  });
  const started = Date.now();
  await shutdown('SIGTERM');
  expect(Date.now() - started).toBeLessThan(1500);
  expect(server.closeAllConnections).toHaveBeenCalled();
  expect(exit).toHaveBeenCalledWith(0);
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('out of time'));
});

test('a second signal exits at once', async () => {
  const exit = jest.fn();
  const shutdown = createShutdown({ drains: [() => new Promise(() => {})], budgetMs: 60000, exit, log: quietLog() });
  shutdown('SIGTERM');
  await shutdown('SIGINT');
  expect(exit).toHaveBeenCalledWith(1);
});

test('a failing step is logged and the rest still runs', async () => {
  const closeDb = jest.fn();
  const exit = jest.fn();
  const log = quietLog();
  const shutdown = createShutdown({
    stopJobs: () => { throw new Error('cron broke'); },
    closeStreams: async () => { throw new Error('stream broke'); },
    drains: [async () => { throw new Error('drain broke'); }],
    closeDb,
    exit,
    log,
  });
  await shutdown('SIGTERM');
  expect(closeDb).toHaveBeenCalled();
  expect(exit).toHaveBeenCalledWith(0);
  expect(log.warn).toHaveBeenCalledTimes(3);
});

test('a hung database close cannot hold the exit', async () => {
  const exit = jest.fn();
  const shutdown = createShutdown({ closeDb: () => new Promise(() => {}), budgetMs: 100, exit, log: quietLog() });
  const started = Date.now();
  await shutdown('SIGTERM');
  expect(Date.now() - started).toBeLessThan(1500);
  expect(exit).toHaveBeenCalledWith(0);
});

test('while draining, responses close their connection', async () => {
  const header = () => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
    drainingConnectionClose({}, res, () => {});
    return res.headers.Connection;
  };
  expect(header()).toBeUndefined();
  createShutdown({ exit: jest.fn(), log: quietLog() })('SIGTERM');
  expect(header()).toBe('close');
});

describe('over a real HTTP server', () => {
  const get = (port, path, agent = false) => new Promise((resolve, reject) => {
    const req = http.get({ port, path, agent }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });

  test('a request being served finishes, streams end, new connections are refused — and the exit is prompt', async () => {
    const app = express();
    app.use(drainingConnectionClose);
    const slow = deferred();
    app.get('/slow', async (req, res) => { await slow.promise; res.json({ ok: true }); });
    // A stream that never ends by itself — like /api/events/stream.
    const openStreams = new Set();
    app.get('/stream', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n');
      openStreams.add(res);
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const { port } = server.address();

    // One request in flight on a KEEP-ALIVE connection, one stream open.
    const keepAlive = new http.Agent({ keepAlive: true });
    const inFlight = get(port, '/slow', keepAlive);
    await new Promise((resolve) => {
      http.get({ port, path: '/stream', agent: false }, (res) => { res.once('data', resolve); res.resume(); });
    });

    const exit = jest.fn();
    const shutdown = createShutdown({
      server,
      closeStreams: () => { for (const res of openStreams) res.end(); },
      budgetMs: 5000,
      exit,
      log: quietLog(),
    });
    const done = shutdown('SIGTERM');

    // New connections are refused from now on…
    await new Promise((r) => setTimeout(r, 30));
    await expect(get(port, '/slow')).rejects.toThrow();
    expect(exit).not.toHaveBeenCalled();
    // …while the request already being served is answered.
    slow.resolve();
    const answer = await inFlight;
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('{"ok":true}');

    // The kept-alive connection is closed as soon as it goes idle — not after
    // Node's 5 s keep-alive timeout.
    const answeredAt = Date.now();
    await done;
    expect(Date.now() - answeredAt).toBeLessThan(1500);
    expect(exit).toHaveBeenCalledWith(0);
    expect(server.listening).toBe(false);
    keepAlive.destroy();
  });
});
