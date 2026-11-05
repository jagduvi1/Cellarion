import { render, screen, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

// A failed sign-in, registration or email check says why in the person's
// language: a coded server error by its translation, a dropped connection as
// one, and anything else in the server's own words (discussion #1798, item 19).
vi.mock('../i18n', () => ({
  default: {
    changeLanguage: vi.fn(),
    // Knows one code; everything else answers with the inline English.
    t: (key, fallback) => (key === 'errors.codes.invalid_credentials' ? 'Feil brukernavn eller passord.' : fallback),
  },
  hasLanguagePreview: () => false,
}));

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function stubFetch(routes) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const route = routes[new URL(String(url), 'http://localhost').pathname];
    return route ? route() : Promise.resolve(json(401, {}));
  }));
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

let ctx;
function Probe() {
  ctx = useAuth();
  return <p>{ctx.loading ? 'loading' : 'ready'}</p>;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

async function renderAuth(routes) {
  stubFetch(routes);
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText('ready');
}

test('a coded login refusal comes back translated, with its code', async () => {
  await renderAuth({
    '/api/auth/login': () => Promise.resolve(json(401, { error: 'Invalid credentials', code: 'invalid_credentials' })),
  });
  let result;
  await act(async () => { result = await ctx.login('anna', 'wrong'); });
  expect(result).toMatchObject({ success: false, error: 'Feil brukernavn eller passord.', code: 'invalid_credentials' });
});

test('a refusal without a translated code keeps the server\'s words', async () => {
  await renderAuth({
    '/api/auth/register': () => Promise.resolve(json(400, { error: 'Password must contain a symbol' })),
  });
  let result;
  await act(async () => { result = await ctx.register('anna', 'anna@example.com', 'pw', true); });
  expect(result).toMatchObject({ success: false, error: 'Password must contain a symbol' });
});

test('a dropped connection says so, instead of "Failed to fetch"', async () => {
  await renderAuth({
    '/api/auth/verify-email': () => Promise.reject(new TypeError('Failed to fetch')),
  });
  let result;
  await act(async () => { result = await ctx.verifyEmail('tok'); });
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/could not be reached/);
});
