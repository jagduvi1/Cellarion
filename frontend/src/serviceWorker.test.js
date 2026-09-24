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

// Cache keys are full URLs; the worker passes both Request-likes and paths.
const keyOf = (req) => {
  const u = typeof req === 'string' ? req : req.url;
  return u.startsWith('/') ? `https://cellarion.test${u}` : u;
};

function makeCaches(initial = {}, network = null) {
  const store = new Map(Object.entries(initial).map(([name, entries]) => [name, new Map(entries)]));
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name);
    return {
      match: async (req) => entries.get(keyOf(req)),
      put: async (req, res) => { entries.set(keyOf(req), res); },
      delete: async (req) => entries.delete(keyOf(req)),
      addAll: async (urls) => {
        const got = [];
        for (const u of urls) {
          const res = await network(u);
          if (!res.ok) throw new TypeError(`addAll: ${u} → ${res.status}`);
          got.push([keyOf(u), res]);
        }
        for (const [k, v] of got) entries.set(k, v);
      },
    };
  };
  return {
    store,
    api: {
      open,
      has: async (name) => store.has(name),
      keys: async () => [...store.keys()],
      delete: async (name) => store.delete(name),
      match: async (req, opts = {}) => {
        if (opts.cacheName) return store.get(opts.cacheName)?.get(keyOf(req));
        for (const entries of store.values()) if (entries.has(keyOf(req))) return entries.get(keyOf(req));
        return undefined;
      },
    },
  };
}

class FakeResponse {
  constructor(body) { this.body = body; this.status = 200; this.ok = true; }
  clone() { return this; }
}

function loadWorker({ caches, network, build = null }) {
  const handlers = {};
  const self = {
    location: { origin: 'https://cellarion.test' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const source = build ? SW_SOURCE.replace('/*__CELLARION_BUILD__*/null', JSON.stringify(build)) : SW_SOURCE;
  vm.runInNewContext(source, {
    self, caches: caches.api, fetch: network, atob, URL, console, Promise, Response: FakeResponse, MessageChannel,
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

describe('service worker offline shell', () => {
  const BUILD = { version: 'v2', files: ['/index.html', '/assets/index-abc.js', '/assets/index-abc.css'] };
  const SHELL = 'cellarion-shell-v2';

  const okNetwork = () => vi.fn(async (u) => fakeResponse(200, `body of ${typeof u === 'string' ? u : u.url}`));
  const offlineNetwork = () => vi.fn(async () => { throw new TypeError('Failed to fetch'); });

  function setup({ initial = {}, network = okNetwork(), build = BUILD } = {}) {
    const caches = makeCaches(initial, network);
    const handlers = loadWorker({ caches, network, build });
    return { caches, handlers, network };
  }

  async function send(handlers, type) {
    const channel = new MessageChannel();
    const reply = new Promise((resolve) => { channel.port1.onmessage = (e) => { channel.port1.close(); resolve(e.data); }; });
    let work;
    handlers.message({ data: { type }, ports: [channel.port2], waitUntil: (p) => { work = p; } });
    await work;
    return reply;
  }

  const navigate = (path = '/cellars/c1') => ({ url: `https://cellarion.test${path}`, method: 'GET', headers: new Headers(), mode: 'navigate' });

  it('offline-enable stores the whole build, marked complete', async () => {
    const { caches, handlers } = setup();
    expect(await send(handlers, 'offline-enable')).toEqual({ type: 'offline-shell', ok: true });
    const shell = caches.store.get(SHELL);
    for (const f of BUILD.files) expect(shell.has(`https://cellarion.test${f}`)).toBe(true);
    expect(shell.has('https://cellarion.test/__cellarion-shell-complete__')).toBe(true);
  });

  it('a second offline-enable downloads nothing', async () => {
    const { handlers, network } = setup();
    await send(handlers, 'offline-enable');
    network.mockClear();
    await send(handlers, 'offline-enable');
    expect(network).not.toHaveBeenCalled();
  });

  it('a failed download leaves no complete shell and reports ok:false', async () => {
    const network = vi.fn(async (u) => (u === '/assets/index-abc.css' ? fakeResponse(404, '') : fakeResponse(200, 'x')));
    const { caches, handlers } = setup({ network });
    expect(await send(handlers, 'offline-enable')).toEqual({ type: 'offline-shell', ok: false });
    const shell = caches.store.get(SHELL);
    expect(shell && shell.has('https://cellarion.test/__cellarion-shell-complete__')).toBeFalsy();
  });

  it('offline navigation opens the stored app when offline mode is on', async () => {
    const network = okNetwork();
    const { handlers } = setup({ network });
    await send(handlers, 'offline-enable');
    network.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    const res = await dispatchFetch(handlers, navigate());
    expect(res.body).toBe('body of /index.html');
  });

  it('offline navigation falls back to offline.html when offline mode is off', async () => {
    const { handlers } = setup({
      initial: { 'cellarion-v4': [['https://cellarion.test/offline.html', fakeResponse(200, 'offline page')]] },
      network: offlineNetwork(),
    });
    const res = await dispatchFetch(handlers, navigate());
    expect(res.body).toBe('offline page');
  });

  it('online navigation still goes to the network', async () => {
    const { handlers } = setup();
    await send(handlers, 'offline-enable');
    const res = await dispatchFetch(handlers, navigate('/racks'));
    expect(res.body).toBe('body of https://cellarion.test/racks');
  });

  it('offline, an older complete shell still opens the app', async () => {
    const old = [
      ['https://cellarion.test/index.html', fakeResponse(200, 'old shell')],
      ['https://cellarion.test/__cellarion-shell-complete__', fakeResponse(200, 'ok')],
    ];
    const { handlers } = setup({ initial: { 'cellarion-shell-v1': old }, network: offlineNetwork() });
    const res = await dispatchFetch(handlers, navigate());
    expect(res.body).toBe('old shell');
  });

  it('install brings the new build down when offline mode is on, and activate then drops the old shell', async () => {
    const old = [['https://cellarion.test/__cellarion-shell-complete__', fakeResponse(200, 'ok')]];
    const { caches, handlers } = setup({ initial: { 'cellarion-shell-v1': old } });
    let work;
    handlers.install({ waitUntil: (p) => { work = p; } });
    await work;
    expect(caches.store.get(SHELL).has('https://cellarion.test/__cellarion-shell-complete__')).toBe(true);
    handlers.activate({ waitUntil: (p) => { work = p; } });
    await work;
    expect(caches.store.has('cellarion-shell-v1')).toBe(false);
    expect(caches.store.has(SHELL)).toBe(true);
  });

  it('install does not download the app when offline mode is off', async () => {
    const { caches, handlers, network } = setup();
    let work;
    handlers.install({ waitUntil: (p) => { work = p; } });
    await work;
    expect(caches.store.has(SHELL)).toBe(false);
    expect(network.mock.calls.map((c) => c[0])).toEqual(['/offline.html', '/manifest.json']);
  });

  it('keeps the old shell when the new one could not be downloaded', async () => {
    const old = [['https://cellarion.test/__cellarion-shell-complete__', fakeResponse(200, 'ok')]];
    const network = vi.fn(async (u) => (u.startsWith('/assets/') ? fakeResponse(500, '') : fakeResponse(200, 'x')));
    const { caches, handlers } = setup({ initial: { 'cellarion-shell-v1': old }, network });
    let work;
    handlers.install({ waitUntil: (p) => { work = p; } });
    await work; // does not throw: the update must not be blocked
    handlers.activate({ waitUntil: (p) => { work = p; } });
    await work;
    expect(caches.store.has('cellarion-shell-v1')).toBe(true);
  });

  it('offline-disable deletes every stored build', async () => {
    const { caches, handlers } = setup({ initial: { 'cellarion-shell-v1': [], [SHELL]: [] } });
    await send(handlers, 'offline-disable');
    expect([...caches.store.keys()].filter((n) => n.startsWith('cellarion-shell-'))).toEqual([]);
  });

  it('without a stamped build (dev server) nothing is stored', async () => {
    const { caches, handlers } = setup({ build: null });
    expect(await send(handlers, 'offline-enable')).toEqual({ type: 'offline-shell', ok: false });
    expect([...caches.store.keys()].some((n) => n.startsWith('cellarion-shell-'))).toBe(false);
  });

  it('offline, a stored bundle is served without an unhandled rejection', async () => {
    const network = okNetwork();
    const { handlers } = setup({ network });
    await send(handlers, 'offline-enable');
    network.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    const res = await dispatchFetch(handlers, { url: 'https://cellarion.test/assets/index-abc.js', method: 'GET', headers: new Headers(), mode: 'no-cors' });
    expect(res.body).toBe('body of /assets/index-abc.js');
  });
});

describe('service worker offline shell — updates', () => {
  it('a new build copies unchanged hashed files from the old shell and downloads only what changed', async () => {
    const OLD = 'cellarion-shell-v1';
    const initial = {
      [OLD]: [
        ['https://cellarion.test/index.html', fakeResponse(200, 'old shell')],
        ['https://cellarion.test/assets/vendor-same.js', fakeResponse(200, 'vendor')],
        ['https://cellarion.test/__cellarion-shell-complete__', fakeResponse(200, 'ok')],
      ],
    };
    const build = { version: 'v2', files: ['/index.html', '/assets/vendor-same.js', '/assets/app-new.js'] };
    const network = vi.fn(async (u) => fakeResponse(200, `fresh ${u}`));
    const caches = makeCaches(initial, network);
    const handlers = loadWorker({ caches, network, build });

    let work;
    handlers.install({ waitUntil: (p) => { work = p; } });
    await work;

    const fetched = network.mock.calls.map((c) => c[0]);
    expect(fetched).toContain('/index.html');          // always fresh
    expect(fetched).toContain('/assets/app-new.js');   // new chunk
    expect(fetched).not.toContain('/assets/vendor-same.js');
    const shell = caches.store.get('cellarion-shell-v2');
    expect(shell.get('https://cellarion.test/assets/vendor-same.js').body).toBe('vendor');
    expect(shell.get('https://cellarion.test/index.html').body).toBe('fresh /index.html');
    expect(shell.has('https://cellarion.test/__cellarion-shell-complete__')).toBe(true);
  });
});

describe('service worker offline photos', () => {
  const THUMB = 'https://cellarion.test/api/uploads/thumbs/processed/abc.png.webp';
  const FULL = '/api/uploads/processed/abc.png';
  const img = (path) => ({ url: `https://cellarion.test${path}`, method: 'GET', headers: new Headers(), mode: 'no-cors' });

  it('serves a saved thumbnail without the network', async () => {
    const network = vi.fn(async () => fakeResponse(200, 'network'));
    const caches = makeCaches({ 'cellarion-photos': [[THUMB, fakeResponse(200, 'saved thumb')]] }, network);
    const handlers = loadWorker({ caches, network });
    const res = await dispatchFetch(handlers, img('/api/uploads/thumbs/processed/abc.png.webp'));
    expect(res.body).toBe('saved thumb');
    expect(network).not.toHaveBeenCalled();
  });

  it('fetches a thumbnail that is not saved', async () => {
    const network = vi.fn(async () => fakeResponse(200, 'network thumb'));
    const handlers = loadWorker({ caches: makeCaches({}, network), network });
    const res = await dispatchFetch(handlers, img('/api/uploads/thumbs/processed/zzz.png.webp'));
    expect(res.body).toBe('network thumb');
  });

  it('online, a full-size photo comes from the network', async () => {
    const network = vi.fn(async () => fakeResponse(200, 'full photo'));
    const caches = makeCaches({ 'cellarion-photos': [[THUMB, fakeResponse(200, 'saved thumb')]] }, network);
    const res = await dispatchFetch(loadWorker({ caches, network }), img(FULL));
    expect(res.body).toBe('full photo');
  });

  it('offline, a full-size photo falls back to its saved thumbnail', async () => {
    const network = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const caches = makeCaches({ 'cellarion-photos': [[THUMB, fakeResponse(200, 'saved thumb')]] }, network);
    const res = await dispatchFetch(loadWorker({ caches, network }), img(FULL));
    expect(res.body).toBe('saved thumb');
  });

  it('offline with no saved thumbnail, the request fails as before', async () => {
    const network = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const handlers = loadWorker({ caches: makeCaches({}, network), network });
    await expect(dispatchFetch(handlers, img(FULL))).rejects.toThrow('Failed to fetch');
  });

  it('activate keeps the photo cache', async () => {
    const caches = makeCaches({ 'cellarion-v4': [], 'cellarion-photos': [], 'something-old': [] });
    const handlers = loadWorker({ caches, network: vi.fn() });
    let work;
    handlers.activate({ waitUntil: (p) => { work = p; } });
    await work;
    expect([...caches.store.keys()].sort()).toEqual(['cellarion-photos', 'cellarion-v4']);
  });
});
