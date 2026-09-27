import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';
import { setOfflineModePreference } from '../utils/offlineMode';

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
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
    stubFetch({ '/api/auth/refresh': offline });
    renderAuth();
    expect(await screen.findByText('user:anna (offline)')).toBeInTheDocument();
    expect(ctx.token).toBeNull();
  });

  it('offline mode off + no network → the login page, as before', async () => {
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() })); // stale leftover
    stubFetch({ '/api/auth/refresh': offline });
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();
  });

  it('a rejected refresh ends the session and deletes the kept profile', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
    stubFetch({ '/api/auth/refresh': () => Promise.resolve(json(401, {})) });
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
  });

  it('an online start with offline mode on keeps a minimal profile for next time', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    stubFetch({
      '/api/auth/refresh': () => Promise.resolve(json(200, { token: 'T1', persistent: true })),
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
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
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
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
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

describe('audit fixes', () => {
  it('a logout made offline is finished before anything else at the next start', async () => {
    localStorage.setItem('cellarion-pending-logout', '1');
    const calls = [];
    const fetchMock = stubFetch({
      '/api/auth/logout': () => { calls.push('logout'); return Promise.resolve(json(200, {})); },
      '/api/auth/refresh': () => { calls.push('refresh'); return Promise.resolve(json(401, {})); },
    });
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();
    expect(calls).toEqual(['logout', 'refresh']);
    expect(localStorage.getItem('cellarion-pending-logout')).toBeNull();
    expect(fetchMock.mock.calls[0][1].headers).toEqual({}); // no token: the cookie identifies the session
  });

  it('still offline with a pending logout → stays signed out, no refresh attempted', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
    localStorage.setItem('cellarion-pending-logout', '1');
    const calls = [];
    stubFetch({
      '/api/auth/logout': () => { calls.push('logout'); return offline(); },
      '/api/auth/refresh': () => { calls.push('refresh'); return offline(); },
    });
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();
    expect(calls).toEqual(['logout']);
    expect(localStorage.getItem('cellarion-pending-logout')).toBe('1');
  });

  it('a logout with no network is remembered for the next start', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
    stubFetch({ '/api/auth/refresh': offline, '/api/auth/logout': offline });
    renderAuth();
    expect(await screen.findByText('user:anna (offline)')).toBeInTheDocument();
    await act(async () => { await ctx.logout(); });
    expect(await screen.findByText('no user')).toBeInTheDocument();
    expect(localStorage.getItem('cellarion-pending-logout')).toBe('1');
  });

  it('a profile kept without a verification stamp (or too old) does not start offline', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify(KEPT_USER));
    stubFetch({ '/api/auth/refresh': offline });
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();
  });

  it('a browser-only session is not kept for an offline start', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    stubFetch({
      '/api/auth/refresh': () => Promise.resolve(json(200, { token: 'T1', persistent: false })),
      '/api/auth/me': () => Promise.resolve(json(200, { user: SERVER_USER })),
    });
    renderAuth();
    expect(await screen.findByText('user:anna')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
  });

  it('one bar of signal (the refresh hangs) → opens offline after a few seconds', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-user', JSON.stringify({ ...KEPT_USER, _verifiedAt: Date.now() }));
    stubFetch({ '/api/auth/refresh': () => new Promise(() => {}) });
    renderAuth();
    expect(await screen.findByText('user:anna (offline)', {}, { timeout: 7000 })).toBeInTheDocument();
  }, 10000);
});

describe('audit 2026-09-27', () => {
  const signedInOnline = () => stubFetch({
    '/api/auth/refresh': () => Promise.resolve(json(200, { token: 'T1', persistent: true })),
    '/api/auth/me': () => Promise.resolve(json(200, { user: SERVER_USER })),
  });

  // M2: the profile was saved only when the user changed, so the prompt's yes
  // (or Settings) mid-session stored the cellar copy but never the profile —
  // and the first start without network showed the login page.
  it('turning offline mode on mid-session keeps the profile for the next start', async () => {
    signedInOnline();
    renderAuth();
    expect(await screen.findByText('user:anna')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull(); // off: nothing stored

    await act(async () => { setOfflineModePreference('on', 'u1'); });

    const kept = JSON.parse(localStorage.getItem('cellarion-offline-user'));
    expect(kept.username).toBe('anna');
    expect(kept.email).toBeUndefined();
  });

  // M3: the choice is one account's. Another account signing in on the device
  // is asked itself — before anything of theirs is stored.
  it('another account\'s choice does not carry over: the sign-in drops it and stores nothing', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    localStorage.setItem('cellarion-offline-owner', 'someone-else');
    signedInOnline();
    renderAuth();
    expect(await screen.findByText('user:anna')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(localStorage.getItem('cellarion-offline')).toBeNull();
    expect(localStorage.getItem('cellarion-offline-owner')).toBeNull();
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
  });

  it('a choice made before owners were recorded is kept for the account signing in', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    signedInOnline();
    renderAuth();
    expect(await screen.findByText('user:anna')).toBeInTheDocument();
    expect(localStorage.getItem('cellarion-offline')).toBe('on');
    expect(localStorage.getItem('cellarion-offline-owner')).toBe('u1');
    await waitFor(() => expect(localStorage.getItem('cellarion-offline-user')).not.toBeNull());
  });

  // Lows. A logout made with no network is finished at the next start — but a
  // sign-in in between makes it moot, and the next start would have posted it
  // with the NEW account's cookie, ending that session.
  it('signing in clears a logout still pending from an offline session', async () => {
    localStorage.setItem('cellarion-pending-logout', '1');
    const routes = { '/api/auth/logout': offline, '/api/auth/refresh': offline };
    stubFetch(routes);
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();
    expect(localStorage.getItem('cellarion-pending-logout')).toBe('1');

    routes['/api/auth/login'] = () => Promise.resolve(json(200, { token: 'T1', persistent: true, user: SERVER_USER }));
    await act(async () => { await ctx.login('anna', 'pw'); });
    expect(await screen.findByText('user:anna')).toBeInTheDocument();
    expect(localStorage.getItem('cellarion-pending-logout')).toBeNull();
  });

  // Register (and the demo) said nothing about the session's kind, so a new
  // account's offline profile was read as browser-only and discarded at once.
  it('a new account\'s "remember me" session keeps the profile for an offline start; a demo never does', async () => {
    localStorage.setItem('cellarion-offline', 'on');
    stubFetch({
      '/api/auth/refresh': offline,
      '/api/auth/register': () => Promise.resolve(json(201, { token: 'T1', persistent: true, user: SERVER_USER })),
      '/api/auth/demo-login': () => Promise.resolve(json(201, { token: 'T2', persistent: false, user: { ...SERVER_USER, isDemo: true } })),
    });
    renderAuth();
    expect(await screen.findByText('no user')).toBeInTheDocument();

    await act(async () => { await ctx.register('anna', 'anna@example.com', 'pw', true); });
    expect(await screen.findByText('user:anna')).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('cellarion-offline-user')).not.toBeNull());

    await act(async () => { await ctx.demoLogin(); });
    await new Promise((r) => setTimeout(r, 20));
    expect(localStorage.getItem('cellarion-offline-user')).toBeNull();
  });
});
