/**
 * Graceful shutdown (scaling audit 2026-09-25).
 *
 * A deploy recreates the backend container: Docker sends SIGTERM, waits 10 s,
 * then SIGKILLs. Node runs as PID 1 in the container, and PID 1 ignores a
 * signal it has no handler for — so every deploy sat out the full 10 s and
 * was then killed mid-work: a photo halfway through background removal stayed
 * 'processing' until the hourly cleanup reset it for a manual retry, and a
 * request being served died with the process.
 *
 * On the first SIGTERM / SIGINT:
 *  1. no new scheduled job run starts;
 *  2. the server stops accepting connections; requests already being served
 *     finish, and their responses carry Connection: close;
 *  3. the long-lived streams end (SSE push, MCP sessions) — their clients
 *     reconnect to the next process on their own;
 *  4. background removals in progress finish;
 *  5. the MongoDB connection closes and the process exits.
 * All within the budget (8 s, under Docker's 10 s stop timeout); whatever is
 * still running then is cut, as it always was. A second signal exits at once.
 *
 * No init process is needed: the backend starts no child processes (nothing
 * to reap), and with a handler installed PID 1 receives the signal like any
 * other process.
 */
const DEFAULT_BUDGET_MS = 8000;
const DB_CLOSE_MAX_MS = 1000;
const IDLE_SWEEP_MS = 250;

let draining = false;

/** True once a shutdown has begun. */
const isDraining = () => draining;

/**
 * Express middleware: while draining, every response closes its connection,
 * so a keep-alive client doesn't send its next request to a server that is
 * about to go.
 */
function drainingConnectionClose(req, res, next) {
  if (draining) res.setHeader('Connection', 'close');
  next();
}

/** `promise` or `ms`, whichever settles first; true when the time ran out. */
function timedOut(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(true), Math.max(0, ms)); });
  return Promise.race([promise.then(() => false), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Build the shutdown routine. Every part is injected, so the sequence is
 * testable without a real server, scheduler or database.
 *
 * @param {object} opts
 * @param {import('http').Server} [opts.server]
 * @param {() => any} [opts.stopJobs]       stop scheduled jobs and timers
 * @param {() => any} [opts.closeStreams]   end SSE streams and MCP sessions
 * @param {Array<() => Promise>} [opts.drains] work to let finish (background removals)
 * @param {() => Promise} [opts.closeDb]
 * @param {number} [opts.budgetMs]
 * @param {(code: number) => void} [opts.exit]
 * @returns {(signal: string) => Promise<void>}
 */
function createShutdown({
  server = null,
  stopJobs,
  closeStreams,
  drains = [],
  closeDb,
  budgetMs = DEFAULT_BUDGET_MS,
  exit = (code) => process.exit(code),
  log = console,
} = {}) {
  let started = false;

  const step = async (name, fn) => {
    try {
      await fn?.();
    } catch (err) {
      log.warn(`[shutdown] ${name} failed:`, err?.message || err);
    }
  };

  return async function shutdown(signal) {
    if (started) {
      log.warn(`[shutdown] ${signal} again — exiting now`);
      exit(1);
      return;
    }
    started = true;
    draining = true;
    const startedAt = Date.now();
    const left = () => budgetMs - (Date.now() - startedAt);
    log.log(`[shutdown] ${signal}: finishing work in progress (up to ${Math.round(budgetMs / 1000)} s)`);

    await step('stopping scheduled jobs', stopJobs);

    // Stop accepting; the callback fires once every connection has ended.
    // close() drops the connections idle right now; one that finishes its
    // request later would sit out the 5 s keep-alive timeout, so sweep the
    // idle ones until the drain is over.
    const serverClosed = server
      ? new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } })
      : Promise.resolve();
    server?.closeIdleConnections?.();
    const idleSweep = server?.closeIdleConnections
      ? setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS)
      : null;

    // Streams never end on their own — end them, or the server never closes.
    await step('closing streams', closeStreams);

    const drained = Promise.all([
      serverClosed,
      ...drains.map((drain) => step('draining', drain)),
    ]);
    if (await timedOut(drained, left())) {
      log.warn('[shutdown] out of time — cutting what is still running');
      server?.closeAllConnections?.();
    }
    if (idleSweep) clearInterval(idleSweep);

    await timedOut(step('closing the database', closeDb), Math.min(DB_CLOSE_MAX_MS, Math.max(left(), 250)));
    log.log(`[shutdown] done in ${Date.now() - startedAt} ms`);
    exit(0);
  };
}

module.exports = {
  createShutdown,
  drainingConnectionClose,
  isDraining,
  DEFAULT_BUDGET_MS,
  // tests only: the draining flag is process-wide by design
  _resetForTests: () => { draining = false; },
};
