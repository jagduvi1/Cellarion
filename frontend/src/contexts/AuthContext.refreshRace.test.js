import { render, screen } from '@testing-library/react';
import { AuthProvider, useAuth, REFRESH_WAIT_MAX_MS } from './AuthContext';

// A reload in the middle of a refresh must not sign the user out: the request
// is keepalive (its rotated cookie still lands after the page is gone), and a
// page that starts right after such a reload waits briefly for that cookie.
vi.mock('../i18n', () => ({ default: { changeLanguage: vi.fn() }, hasLanguagePreview: () => false }));

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const USER = { _id: 'u1', id: 'u1', username: 'anna', roles: ['user'], preferences: {} };

let refreshCalls;
function stubFetch() {
  refreshCalls = [];
  vi.stubGlobal('fetch', vi.fn((url, init) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    if (path === '/api/auth/refresh') {
      refreshCalls.push({ at: Date.now(), init, markerWhileInFlight: localStorage.getItem('cellarion-refresh-inflight') });
      return Promise.resolve(json(200, { token: 'T1' }));
    }
    if (path === '/api/auth/me') return Promise.resolve(json(200, { user: USER }));
    return Promise.resolve(json(404, {}));
  }));
}

function Probe() {
  const { user, loading } = useAuth();
  return <p>{loading ? 'loading' : user ? `user:${user.username}` : 'no user'}</p>;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

it('the refresh request is keepalive and marked while in flight, unmarked after', async () => {
  render(<AuthProvider><Probe /></AuthProvider>);
  expect(await screen.findByText('user:anna')).toBeInTheDocument();
  expect(refreshCalls[0].init).toMatchObject({ method: 'POST', credentials: 'include', keepalive: true });
  expect(refreshCalls[0].markerWhileInFlight).toMatch(/^\d+$/);
  expect(localStorage.getItem('cellarion-refresh-inflight')).toBeNull();
});

it('a page starting right after a reload mid-refresh waits for that refresh\'s cookie', async () => {
  // The previous page started a refresh 4 s ago and was unloaded before it finished.
  localStorage.setItem('cellarion-refresh-inflight', String(Date.now() - 4000));
  const t0 = Date.now();
  render(<AuthProvider><Probe /></AuthProvider>);
  expect(await screen.findByText('user:anna', {}, { timeout: 4000 })).toBeInTheDocument();
  const waited = refreshCalls[0].at - t0;
  expect(waited).toBeGreaterThanOrEqual(900);            // the ~1 s left of the 5 s window
  expect(waited).toBeLessThan(REFRESH_WAIT_MAX_MS + 500);
});

it('a stale marker (a refresh that died long ago) costs no wait', async () => {
  localStorage.setItem('cellarion-refresh-inflight', String(Date.now() - 60000));
  const t0 = Date.now();
  render(<AuthProvider><Probe /></AuthProvider>);
  expect(await screen.findByText('user:anna')).toBeInTheDocument();
  expect(refreshCalls[0].at - t0).toBeLessThan(500);
});

it('a garbage marker is ignored', async () => {
  localStorage.setItem('cellarion-refresh-inflight', 'not-a-time');
  const t0 = Date.now();
  render(<AuthProvider><Probe /></AuthProvider>);
  expect(await screen.findByText('user:anna')).toBeInTheDocument();
  expect(refreshCalls[0].at - t0).toBeLessThan(500);
});
