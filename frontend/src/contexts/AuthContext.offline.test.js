import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

// Offline start (#1355): a refresh that gets NO answer is not a dead session.
vi.mock('../i18n', () => ({ default: { changeLanguage: vi.fn() }, hasLanguagePreview: () => false }));

const SERVER_USER = {
  _id: 'u1', id: 'u1', username: 'anna', email: 'anna@example.com', roles: ['user'], plan: 'free',
  preferences: {}, isSuperAdmin: false,
};
const KEPT_USER = { _id: 'u1', id: 'u1', username: 'anna', roles: ['user'], plan: 'free', preferences: {} };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

// Routes fetch by path; each entry is a function returning a response promise.
function stubFetch(routes) {
  const fn = vi.fn((url) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    const route = routes[path];
    return route ? route() : Promise.resolve(json(404, {}));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let ctx;
function Probe() {
  ctx = useAuth();
  if (ctx.loading) return <p>loading</p>;
  return <p>{ctx.user ? `user:${ctx.user.username}${ctx.offlineSession ? ' (offline)' : ''}` : 'no user'}</p>;
}
const renderAuth = () => render(<AuthProvider><Probe /></AuthProvider>);

// The 'online' listener is attached in an effect that can run after the first
// offline render is visible, so keep announcing the network until it lands.
const goOnlineUntil = (assertion) => waitFor(async () => {
  await act(async () => { window.dispatchEvent(new Event('online')); });
  assertion();
});

// Node >=22 ships a global localStorage stub that shadows jsdom's (no clear()).
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
afterEach(() => vi.unstubAllGlobals());

describe('AuthProvider offline start', () => {
  it('offline mode on + no network at startup → carries on as the kept user, offline', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify(KEPT_USER));
    stubFetch({ '/api/auth/refresh': offline });
    renderAuth();
    expect(await screen.findByText('user:anna (offline)')).toBeInTheDocument();
    expect(ctx.token).toBeNull();
  });

  it('offline mode off + no network → the login page, as before', async () => {
    localStorage.setItem('cellarion-offline-user', JSON.stringify(KEPT_USER)); // stale leftover
    stubFetch({ '/api/auth/refresh': offline });
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();
  });

  it('a rejected refresh ends the session and deletes the kept profile', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify(KEPT_USER));
    stubFetch({ '/api/auth/refresh': () => Promise.resolve(json(401, {})) });
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
  });

  it('an online start with offline mode on keeps a minimal profile for next time', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    stubFetch({
      '/api/auth/refresh': () => Promise.resolve(json(200, { token: 'T1' })),
      '/api/auth/me': () => Promise.resolve(json(200, { user: SERVER_USER })),
    });
    renderAuth();
    expect(await screen.findByText('user:anna')).toBeInTheDocument();
    // Saved in an effect, which may land a beat after the render.
    await waitFor(() => expect(localStorage.getItem('cellarion-offline-user')).not.toBeNull());
    const kept = JSON.parse(localStorage.getItem('cellarion-offline-user'));
    expect(kept.username).toBe('anna');
    expect(kept.email).toBeUndefined();
    expect(kept.isSuperAdmin).toBeUndefined();
  });

  it('leaves the offline session when the network comes back', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify(KEPT_USER));
    const routes = { '/api/auth/refresh': offline };
    stubFetch(routes);
    renderAuth();
    expect(await screen.findByText('user:anna (offline)')).toBeInTheDocument();

    routes['/api/auth/refresh'] = () => Promise.resolve(json(200, { token: 'T2' }));
    routes['/api/auth/me'] = () => Promise.resolve(json(200, { user: SERVER_USER }));
    await goOnlineUntil(() => screen.getByText('user:anna'));
    expect(ctx.token).toBe('T2');
  });

  it('ends the offline session if the server rejects it on reconnect', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify(KEPT_USER));
    const routes = { '/api/auth/refresh': offline, '/api/auth/logout': () => Promise.resolve(json(200, {})) };
    stubFetch(routes);
    renderAuth();
    expect(await screen.findByText('user:anna (offline)')).toBeInTheDocument();

    routes['/api/auth/refresh'] = () => Promise.resolve(json(401, {}));
    await goOnlineUntil(() => screen.getByText('no user'));
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
  });
});

describe('apiFetch when a refresh gets no answer', () => {
  it('does not log the user out (a dropped signal is not a dead session)', async () => {
    const routes = {
      '/api/auth/refresh': () => Promise.resolve(json(200, { token: 'T1' })),
      '/api/auth/me': () => Promise.resolve(json(200, { user: SERVER_USER })),
      '/api/cellars': () => Promise.resolve(json(401, {})),
    };
    stubFetch(routes);
    renderAuth();
    expect(await screen.findByText('user:anna')).toBeInTheDocument();

    routes['/api/auth/refresh'] = offline;
    let res;
    await act(async () => { res = await ctx.apiFetch('/api/cellars'); });
    expect(res.status).toBe(401);
    await waitFor(() => expect(screen.getByText('user:anna')).toBeInTheDocument());
  });

  it('still logs out when the server rejects the refresh', async () => {
    const routes = {
      '/api/auth/refresh': () => Promise.resolve(json(200, { token: 'T1' })),
      '/api/auth/me': () => Promise.resolve(json(200, { user: SERVER_USER })),
      '/api/cellars': () => Promise.resolve(json(401, {})),
      '/api/auth/logout': () => Promise.resolve(json(200, {})),
    };
    stubFetch(routes);
    renderAuth();
    expect(await screen.findByText('user:anna')).toBeInTheDocument();

    routes['/api/auth/refresh'] = () => Promise.resolve(json(401, {}));
    await act(async () => { await ctx.apiFetch('/api/cellars'); });
    expect(await screen.findByText('no user')).toBeInTheDocument();
  });
});
