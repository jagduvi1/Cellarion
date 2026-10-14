import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';
import i18n from '../i18n';

// A new account used to be switched to English at its first sign-in (the stored
// language was only the server default) and to start on USD. The server now
// marks a new account (localeDefaultsPending); its first sign-in keeps the
// language on screen and saves it, with the device's currency, exactly once.
vi.mock('../i18n', () => ({
  default: { changeLanguage: vi.fn(), resolvedLanguage: 'sv', language: 'sv-SE' },
  hasLanguagePreview: () => false,
}));
vi.mock('../utils/localeDefaults', () => ({ guessCurrency: () => 'SEK' }));

const BASE_USER = {
  _id: 'u1', id: 'u1', username: 'anna', email: 'anna@example.com', roles: ['user'], plan: 'free',
  preferences: { currency: 'USD', language: 'en' },
};

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let calls;
function stubFetch(meUser, savedUser) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url, init = {}) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (path === '/api/auth/refresh') return Promise.resolve(json(200, { token: 'T1' }));
    if (path === '/api/auth/me') return Promise.resolve(json(200, { user: meUser }));
    if (path === '/api/users/me/locale-defaults') return Promise.resolve(json(200, { applied: true, user: savedUser }));
    return Promise.resolve(json(404, {}));
  }));
}

function Probe() {
  const { loading, user } = useAuth();
  if (loading || !user) return <p>loading</p>;
  return <p>{`currency:${user.preferences.currency} language:${user.preferences.language}`}</p>;
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
  i18n.changeLanguage.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

it('a new account keeps the language it signed up in and saves it with its currency', async () => {
  stubFetch(
    { ...BASE_USER, localeDefaultsPending: true },
    { ...BASE_USER, preferences: { currency: 'SEK', language: 'sv' } },
  );
  render(<AuthProvider><Probe /></AuthProvider>);

  expect(await screen.findByText('currency:SEK language:sv')).toBeInTheDocument();
  const saves = calls.filter((c) => c.path === '/api/users/me/locale-defaults');
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ method: 'POST', body: { language: 'sv', currency: 'SEK' } });
  // The stored 'en' was never applied over the Swedish the visitor was reading.
  expect(i18n.changeLanguage).not.toHaveBeenCalledWith('en');
});

it('an existing account is never touched and gets its stored language', async () => {
  stubFetch(BASE_USER, null);
  render(<AuthProvider><Probe /></AuthProvider>);

  expect(await screen.findByText('currency:USD language:en')).toBeInTheDocument();
  await waitFor(() => expect(i18n.changeLanguage).toHaveBeenCalledWith('en'));
  expect(calls.some((c) => c.path === '/api/users/me/locale-defaults')).toBe(false);
});
