/**
 * Where a successful password sign-in lands. Router state is the #1165 path and
 * already worked; the stash covers coming back to /login after an SSO attempt
 * that failed or was cancelled, where "Back to login" navigates without state.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Login from './Login';
import { stashPostLoginRedirect, takePostLoginRedirect } from '../utils/postLoginRedirect';

// t returns the key, or the inline English fallback where one is given.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
  Trans: ({ children }) => children,
}));

const navigateMock = vi.fn();
let routerLocation;
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => routerLocation,
}));

const loginMock = vi.fn();
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ login: loginMock, register: vi.fn() }),
}));

vi.mock('../hooks/useVersion', () => ({ default: () => null }));

beforeEach(() => {
  window.sessionStorage.clear();
  navigateMock.mockReset();
  routerLocation = { pathname: '/login', search: '', state: null };
  loginMock.mockReset().mockResolvedValue({ success: true });
  // The SSO-providers probe; the button itself is not under test here.
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ google: false }) });
});

// The mode toggle carries the same label as the submit button, so target the
// form's submit directly rather than by accessible name.
const signIn = async () => {
  fireEvent.change(screen.getByLabelText('auth.usernameOrEmail'), { target: { value: 'someone' } });
  fireEvent.change(screen.getByLabelText('auth.passwordLabel'), { target: { value: 'hunter2' } });
  fireEvent.click(document.querySelector('form button[type="submit"]'));
};

test('router state still wins — #1165 is untouched', async () => {
  routerLocation.state = { from: '/cellars/abc/room?focusRack=def' };
  render(<Login />);
  await signIn();
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/abc/room?focusRack=def'));
});

test('falls back to a stashed destination when the router state is gone', async () => {
  // The shape after cancelling at the provider: "Back to login" navigates
  // without state, so only the stash remembers where they were heading.
  stashPostLoginRedirect('/wishlist');
  render(<Login />);
  await signIn();
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/wishlist'));
});

test('a plain sign-in with neither still lands on /cellars', async () => {
  render(<Login />);
  await signIn();
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars'));
});

test('consumes the stash even when router state wins, so it cannot be inherited later', async () => {
  routerLocation.state = { from: '/cellars' };
  stashPostLoginRedirect('/wishlist');
  render(<Login />);
  await signIn();
  await waitFor(() => expect(navigateMock).toHaveBeenCalled());
  expect(takePostLoginRedirect()).toBeNull();
});
