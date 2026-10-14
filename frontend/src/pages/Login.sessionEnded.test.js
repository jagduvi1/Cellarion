/**
 * Landing on the login page because the server ended a session that was in
 * use: the page says so (once), instead of looking like a fresh visit.
 */
import { render, screen } from '@testing-library/react';
import Login from './Login';
import { markSessionExpired, wasSessionExpired } from '../utils/sessionExpired';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
  Trans: ({ children }) => children,
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/login', search: '', state: null }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ login: vi.fn(), register: vi.fn() }) }));
vi.mock('../hooks/useVersion', () => ({ default: () => null }));

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage());
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(() => vi.unstubAllGlobals());

test('after the server ended the session, the login page says so — once', () => {
  markSessionExpired();
  const first = render(<Login />);
  expect(screen.getByText(/Your session ended/)).toBeInTheDocument();
  expect(wasSessionExpired()).toBe(false);
  first.unmount();

  render(<Login />);
  expect(screen.queryByText(/Your session ended/)).not.toBeInTheDocument();
});

test('a plain visit shows no such notice', () => {
  render(<Login />);
  expect(screen.queryByText(/Your session ended/)).not.toBeInTheDocument();
});
