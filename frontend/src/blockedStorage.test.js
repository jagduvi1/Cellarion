import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import AnnouncementBanner from './components/AnnouncementBanner';
import InstallPrompt from './components/InstallPrompt';
import Restock from './pages/Restock';
import { readBottleViewMode, storeBottleViewMode } from './utils/bottleViewMode';

// A browser that blocks site data for the site throws a SecurityError from the
// localStorage / sessionStorage getters themselves. The app must still start
// (light theme, choices not remembered) and sign-out must still finish,
// instead of the root ErrorBoundary replacing everything.

vi.mock('./i18n', () => ({
  default: { changeLanguage: vi.fn(), t: (k) => k },
  hasLanguagePreview: () => false,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, fallback) => (typeof fallback === 'string' ? fallback : k),
    i18n: { language: 'en' },
  }),
}));

const SERVER_USER = { _id: 'u1', id: 'u1', username: 'anna', email: 'anna@example.com', roles: ['user'], plan: 'free', preferences: {} };
const ANNOUNCEMENT = { enabled: true, message: 'Planned maintenance at 18:15 UTC', type: 'info', updatedAt: '2026-10-01T00:00:00.000Z' };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ROUTES = {
  '/api/auth/refresh': () => json(200, { token: 'T1' }),
  '/api/auth/me': () => json(200, { user: SERVER_USER }),
  '/api/auth/logout': () => json(200, {}),
  '/api/site/announcement': () => json(200, ANNOUNCEMENT),
};

const AREAS = ['localStorage', 'sessionStorage'];
let saved;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const route = ROUTES[new URL(String(url), 'http://localhost').pathname];
    return route ? route() : json(404, {});
  }));
  saved = AREAS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const name of AREAS) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });
  }
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  for (const [name, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete globalThis[name];
  }
  vi.unstubAllGlobals();
});

let auth;
let theme;
function Probe() {
  auth = useAuth();
  theme = useTheme();
  if (auth.loading) return <p>loading</p>;
  return <p>{auth.user ? `user:${auth.user.username}` : 'no user'}</p>;
}

// The providers in the order App.js nests them, under the root ErrorBoundary
// as index.js mounts it.
function renderApp(children) {
  return render(
    <ErrorBoundary>
      <ThemeProvider>
        <MemoryRouter>
          <AuthProvider>
            <Probe />
            {children}
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

it('the storage getters really throw in these tests', () => {
  expect(() => window.localStorage).toThrow('insecure');
  expect(() => window.sessionStorage).toThrow('insecure');
});

it('the app providers start, signed in, in the light theme', async () => {
  renderApp();
  expect(await screen.findByText('user:anna')).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  expect(theme.theme).toBe('light');
});

it('the theme still toggles, it is just not remembered', async () => {
  renderApp();
  await screen.findByText('user:anna');
  act(() => theme.toggleTheme());
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
});

it('logout completes and leaves nobody signed in', async () => {
  renderApp();
  await screen.findByText('user:anna');
  await act(async () => { await auth.logout(); });
  expect(screen.getByText('no user')).toBeInTheDocument();
  expect(auth.token).toBeNull();
});

it('the announcement banner shows and can be dismissed', async () => {
  renderApp(<AnnouncementBanner />);
  expect(await screen.findByText('Planned maintenance at 18:15 UTC')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'announcement.dismiss' }));
  expect(screen.queryByText('Planned maintenance at 18:15 UTC')).not.toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
});

it('the install prompt shows and can be dismissed', async () => {
  renderApp(<InstallPrompt />);
  await screen.findByText('user:anna');
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  act(() => { window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true })); });
  expect(screen.getByText('installPrompt.message')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'installPrompt.dismiss' }));
  expect(screen.queryByText('installPrompt.message')).not.toBeInTheDocument();
});

it('the restock page renders', async () => {
  renderApp(<Restock />);
  expect(await screen.findByText('Smart Restock')).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
});

it("the cellar's list/card choice falls back to the list and is not remembered", () => {
  expect(readBottleViewMode()).toBe('list');
  expect(() => storeBottleViewMode('card')).not.toThrow();
});
