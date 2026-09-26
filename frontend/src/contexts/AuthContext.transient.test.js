import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth, refreshOutcome, START_RETRY_DELAYS_MS } from './AuthContext';

// A refresh the server couldn't serve — a deploy restarting it (502/503), a
// hiccup, a rate limit (429) — is not a dead session. Only 401 ends it
// (scaling audit 2026-09-25).
vi.mock('../i18n', () => ({ default: { changeLanguage: vi.fn() }, hasLanguagePreview: () => false }));

const SERVER_USER = {
  _id: 'u1', id: 'u1', username: 'anna', email: 'anna@example.com', roles: ['user'], plan: 'free',
  preferences: {}, isSuperAdmin: false,
};
const KEPT_USER = { _id: 'u1', id: 'u1', username: 'anna', roles: ['user'], plan: 'free', preferences: {} };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const answer = (status, body = {}) => () => Promise.resolve(json(status, body));

function stubFetch(routes) {
  const fn = vi.fn((url) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    const route = routes[path];
    return route ? route() : Promise.resolve(json(404, {}));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const callsTo = (fn, path) => fn.mock.calls.filter(([url]) => new URL(String(url), 'http://localhost').pathname === path).length;

let ctx;
function Probe() {
  ctx = useAuth();
  if (ctx.loading) return <p>loading</p>;
  return <p>{ctx.user ? `user:${ctx.user.username}${ctx.offlineSession ? ' (offline)' : ''}` : 'no user'}</p>;
}
const renderAuth = () => render(<AuthProvider><Probe /></AuthProvider>);

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('refreshOutcome', () => {
  it.each([200, 204])('%i → ok', (s) => expect(refreshOutcome(s)).toBe('ok'));
  it.each([400, 401, 403, 404])('%i → rejected (the session is over)', (s) => expect(refreshOutcome(s)).toBe('rejected'));
  it.each([408, 425, 429, 500, 502, 503, 504, 520, 522])('%i → unavailable (try again later)', (s) => expect(refreshOutcome(s)).toBe('unavailable'));
});

describe('a refresh during a deploy or a hiccup', () => {
  async function signedIn(extra = {}) {
    const routes = {
      '/api/auth/refresh': answer(200, { token: 'T1' }),
      '/api/auth/me': answer(200, { user: SERVER_USER }),
      '/api/cellars': answer(401),
      '/api/auth/logout': answer(200),
      ...extra,
    };
    const fetchFn = stubFetch(routes);
    renderAuth();
    expect(await screen.findByText('user:anna')).toBeInTheDocument();
    return { routes, fetchFn };
  }

  it.each([502, 503, 429])('a %i on refresh keeps the user signed in; the request just fails', async (status) => {
    const { routes, fetchFn } = await signedIn();
    routes['/api/auth/refresh'] = answer(status);
    let res;
    await act(async () => { res = await ctx.apiFetch('/api/cellars'); });
    expect(res.status).toBe(401);
    expect(screen.getByText('user:anna')).toBeInTheDocument();
    expect(callsTo(fetchFn, '/api/auth/logout')).toBe(0);
  });

  it('once the server is back, the next request refreshes and goes through', async () => {
    const { routes } = await signedIn();
    routes['/api/auth/refresh'] = answer(502);
    await act(async () => { await ctx.apiFetch('/api/cellars'); });

    routes['/api/auth/refresh'] = answer(200, { token: 'T2' });
    let calls = 0;
    routes['/api/cellars'] = () => Promise.resolve(json(calls++ === 0 ? 401 : 200, { cellars: [] }));
    let res;
    await act(async () => { res = await ctx.apiFetch('/api/cellars'); });
    expect(res.status).toBe(200);
    expect(ctx.token).toBe('T2');
    expect(screen.getByText('user:anna')).toBeInTheDocument();
  });

  it('a 401 on refresh still ends the session', async () => {
    const { routes } = await signedIn();
    routes['/api/auth/refresh'] = answer(401);
    await act(async () => { await ctx.apiFetch('/api/cellars'); });
    expect(await screen.findByText('no user')).toBeInTheDocument();
  });
});

describe('starting the app during a deploy', () => {
  it('with no device copy: keeps trying for a few seconds, then carries on signed in', async () => {
    let tries = 0;
    stubFetch({
      '/api/auth/refresh': () => Promise.resolve(tries++ === 0 ? json(502, {}) : json(200, { token: 'T1' })),
      '/api/auth/me': answer(200, { user: SERVER_USER }),
    });
    renderAuth();
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(await screen.findByText('user:anna', {}, { timeout: START_RETRY_DELAYS_MS[0] + 2000 })).toBeInTheDocument();
    expect(tries).toBe(2);
  });

  it('gives up after the retries — the login page, with nothing on the device deleted', async () => {
    vi.useFakeTimers();
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() })); // offline mode off: not used, not wiped
    const fetchFn = stubFetch({ '/api/auth/refresh': answer(503) });
    renderAuth();
    const total = START_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    await act(async () => { await vi.advanceTimersByTimeAsync(total + 1000); });
    expect(screen.getByText('no user')).toBeInTheDocument();
    expect(callsTo(fetchFn, '/api/auth/refresh')).toBe(1 + START_RETRY_DELAYS_MS.length);
    expect(localStorage.getItem('cellarion-offline-user')).not.toBeNull();
  });

  it('with offline mode: opens the device copy instead of wiping it', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
    stubFetch({ '/api/auth/refresh': answer(503) });
    renderAuth();
    expect(await screen.findByText('user:anna (offline)')).toBeInTheDocument();
    expect(localStorage.getItem('cellarion-offline-user')).not.toBeNull();
  });

  it('a profile request the server cannot answer yet is retried with the fresh token', async () => {
    let meCalls = 0;
    stubFetch({
      '/api/auth/refresh': answer(200, { token: 'T1' }),
      '/api/auth/me': () => Promise.resolve(meCalls++ === 0 ? json(503, {}) : json(200, { user: SERVER_USER })),
    });
    renderAuth();
    expect(await screen.findByText('user:anna', {}, { timeout: START_RETRY_DELAYS_MS[0] + 2000 })).toBeInTheDocument();
    expect(meCalls).toBe(2);
  });
});

describe('offline mode reconnecting during a deploy', () => {
  it('stays in the offline session instead of signing out', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
    const routes = { '/api/auth/refresh': () => Promise.reject(new TypeError('Failed to fetch')) };
    const fetchFn = stubFetch(routes);
    renderAuth();
    expect(await screen.findByText('user:anna (offline)')).toBeInTheDocument();

    routes['/api/auth/refresh'] = answer(502);
    const before = callsTo(fetchFn, '/api/auth/refresh');
    await waitFor(async () => {
      await act(async () => { window.dispatchEvent(new Event('online')); });
      expect(callsTo(fetchFn, '/api/auth/refresh')).toBeGreaterThan(before);
    });
    expect(screen.getByText('user:anna (offline)')).toBeInTheDocument();
    expect(localStorage.getItem('cellarion-offline-user')).not.toBeNull();
  });
});
