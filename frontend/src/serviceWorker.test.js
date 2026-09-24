import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// Runs the real public/service-worker.js in a sandbox with an in-memory Cache
// API and a stubbed network, and drives its fetch handler directly.

const SW_SOURCE = readFileSync(resolve(__dirname, '../public/service-worker.js'), 'utf8');

const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenFor = (id) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ id, roles: ['user'] })}.signature`;

function fakeResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, body, clone() { return this; } };
}

function makeCaches(initial = {}) {
  const store = new Map(Object.entries(initial).map(([name, entries]) => [name, new Map(entries)]));
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name);
    return {
      match: async (req) => entries.get(req.url),
      put: async (req, res) => { entries.set(req.url, res); },
      delete: async (req) => entries.delete(req.url),
      addAll: async () => {},
    };
  };
  return {
    store,
    api: {
      open,
      keys: async () => [...store.keys()],
      delete: async (name) => store.delete(name),
      match: async () => undefined,
    },
  };
}

function loadWorker({ caches, network }) {
  const handlers = {};
  const self = {
    location: { origin: 'https://cellarion.test' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  vm.runInNewContext(SW_SOURCE, {
    self, caches: caches.api, fetch: network, atob, URL, console, Promise,
  });
  return handlers;
}

function request(path, { token, method = 'GET' } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return { url: `https://cellarion.test${path}`, method, headers, mode: 'cors' };
}

async function dispatchFetch(handlers, req) {
  let responded = null;
  handlers.fetch({ request: req, respondWith: (p) => { responded = p; } });
  return responded ? await responded : null; // null = handler let it through
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('service worker API cache', () => {
  it('caches cellar responses per account, never across accounts', async () => {
    const caches = makeCaches();
    const network = vi.fn(async () => fakeResponse(200, 'fresh'));
    const handlers = loadWorker({ caches, network });

    await dispatchFetch(handlers, request('/api/cellars/c1', { token: tokenFor(ALICE) }));
    await flush();
    expect(caches.store.get(`cellarion-api-v2-${ALICE}`).has('https://cellarion.test/api/cellars/c1')).toBe(true);

    // Bob asks for the same URL: he must not be served Alice's cached copy.
    network.mockImplementation(async () => fakeResponse(403, 'forbidden'));
    const res = await dispatchFetch(handlers, request('/api/cellars/c1', { token: tokenFor(BOB) }));
    expect(res.status).toBe(403);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('serves the same account its cached copy (stale-while-revalidate)', async () => {
    const caches = makeCaches({
      [`cellarion-api-v2-${ALICE}`]: [['https://cellarion.test/api/bottles/b1', fakeResponse(200, 'cached')]],
    });
    const network = vi.fn(async () => fakeResponse(200, 'fresh'));
    const handlers = loadWorker({ caches, network });

    const res = await dispatchFetch(handlers, request('/api/bottles/b1', { token: tokenFor(ALICE) }));
    expect(res.body).toBe('cached');
  });

  it('does not cache requests without a readable bearer token', async () => {
    const caches = makeCaches();
    const network = vi.fn(async () => fakeResponse(200, 'fresh'));
    const handlers = loadWorker({ caches, network });

    expect(await dispatchFetch(handlers, request('/api/wines/w1'))).toBeNull();
    expect(await dispatchFetch(handlers, request('/api/wines/w1', { token: 'not-a-jwt' }))).toBeNull();
    expect(await dispatchFetch(handlers, request('/api/wines/w1', { token: tokenFor('../../evil') }))).toBeNull();
    expect(caches.store.size).toBe(0);
  });

  it('drops a cached copy once the server answers 403 or 404', async () => {
    const url = 'https://cellarion.test/api/cellars/shared';
    const caches = makeCaches({ [`cellarion-api-v2-${ALICE}`]: [[url, fakeResponse(200, 'cached')]] });
    const network = vi.fn(async () => fakeResponse(403, 'revoked'));
    const handlers = loadWorker({ caches, network });

    await dispatchFetch(handlers, request('/api/cellars/shared', { token: tokenFor(ALICE) }));
    await flush();
    expect(caches.store.get(`cellarion-api-v2-${ALICE}`).has(url)).toBe(false);
  });

  it('wipes every account cache on an API write', async () => {
    const caches = makeCaches({
      'cellarion-v4': [],
      [`cellarion-api-v2-${ALICE}`]: [],
      [`cellarion-api-v2-${BOB}`]: [],
    });
    const handlers = loadWorker({ caches, network: vi.fn() });

    await dispatchFetch(handlers, request('/api/bottles/b1/consume', { token: tokenFor(ALICE), method: 'POST' }));
    await flush();
    expect([...caches.store.keys()]).toEqual(['cellarion-v4']);
  });

  it('deletes the old shared v1 API cache on activate', async () => {
    const caches = makeCaches({
      'cellarion-v4': [],
      'cellarion-api-v1': [],
      [`cellarion-api-v2-${ALICE}`]: [],
    });
    const handlers = loadWorker({ caches, network: vi.fn() });

    let done;
    handlers.activate({ waitUntil: (p) => { done = p; } });
    await done;
    expect([...caches.store.keys()].sort()).toEqual(['cellarion-api-v2-' + ALICE, 'cellarion-v4']);
  });
});
