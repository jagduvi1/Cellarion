import { render, screen, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

// Only GET /api/auth/me stamps isSuperAdmin (email AND address). A preference
// save echoes the user without it, and replacing the signed-in user with that
// echo hid the SuperAdmin link until the next reload. The cellar page now
// saves the sort on every pick, so this would happen all the time.
vi.mock('../i18n', () => ({ default: { changeLanguage: vi.fn() }, hasLanguagePreview: () => false }));

const SERVER_USER = {
  _id: 'u1', id: 'u1', username: 'anna', email: 'anna@example.com', roles: ['user', 'admin'], plan: 'free',
  preferences: { currency: 'SEK' },
};

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const answer = (status, body = {}) => () => Promise.resolve(json(status, body));

function stubFetch(routes) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const route = routes[new URL(String(url), 'http://localhost').pathname];
    return route ? route() : Promise.resolve(json(404, {}));
  }));
}

let ctx;
function Probe() {
  ctx = useAuth();
  if (ctx.loading || !ctx.user) return <p>loading</p>;
  return <p>{`admin:${ctx.user.isSuperAdmin} sort:${ctx.user.preferences?.cellarSort ?? '-'}`}</p>;
}

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

async function signedInAs(isSuperAdmin) {
  stubFetch({
    '/api/auth/refresh': answer(200, { token: 'T1' }),
    '/api/auth/me': answer(200, { user: { ...SERVER_USER, isSuperAdmin } }),
    // The echo carries the saved preference but, like the real route, no stamp.
    '/api/users/preferences': answer(200, { user: { ...SERVER_USER, preferences: { currency: 'SEK', cellarSort: 'maturity' } } }),
  });
  render(<AuthProvider><Probe /></AuthProvider>);
  expect(await screen.findByText(`admin:${isSuperAdmin} sort:-`)).toBeInTheDocument();
}

it('a preference save keeps the super-admin stamp from /me', async () => {
  await signedInAs(true);
  await act(async () => { await ctx.updatePreferences({ cellarSort: 'maturity' }); });
  expect(screen.getByText('admin:true sort:maturity')).toBeInTheDocument();
});

it('and never grants it to anyone else', async () => {
  await signedInAs(false);
  await act(async () => { await ctx.updatePreferences({ cellarSort: 'maturity' }); });
  expect(screen.getByText('admin:false sort:maturity')).toBeInTheDocument();
});
