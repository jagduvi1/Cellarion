import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import OAuthCallback from './OAuthCallback';
import { stashPostLoginRedirect, takePostLoginRedirect } from '../utils/postLoginRedirect';

const navigateMock = vi.fn();
let searchParams;
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

let authState;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));

beforeEach(() => {
  window.sessionStorage.clear();
  navigateMock.mockReset();
  searchParams = new URLSearchParams();
  authState = { user: { _id: 'u1' } };
});

test('finishes the journey the deep link started (#1165, now for SSO too)', () => {
  stashPostLoginRedirect('/cellars/abc/room?focusRack=def');
  render(<OAuthCallback />);
  expect(navigateMock).toHaveBeenCalledWith('/cellars/abc/room?focusRack=def', { replace: true });
});

test('a plain sign-in with no destination still lands on /cellars', () => {
  render(<OAuthCallback />);
  expect(navigateMock).toHaveBeenCalledWith('/cellars', { replace: true });
});

test('a destination is consumed once, so a later sign-in is not steered by it', () => {
  stashPostLoginRedirect('/wishlist');
  render(<OAuthCallback />);
  expect(takePostLoginRedirect()).toBeNull();
});

test('a session that did not restore goes to /login and keeps the destination for the retry', () => {
  authState.user = null;
  stashPostLoginRedirect('/wishlist');
  render(<OAuthCallback />);
  expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true });
  expect(takePostLoginRedirect()).toBe('/wishlist');
});

test('a failed sign-in does not navigate and keeps the destination for the retry', () => {
  searchParams = new URLSearchParams({ error: 'access_denied' });
  stashPostLoginRedirect('/wishlist');
  render(<OAuthCallback />);
  expect(navigateMock).not.toHaveBeenCalled();
  expect(takePostLoginRedirect()).toBe('/wishlist');
});

test('survives StrictMode\'s dev double-mount — the destination is not overwritten by /cellars', () => {
  // Dev runs under React.StrictMode (index.js:11), which invokes mount effects
  // twice. The stash is single-use, so an unguarded effect consumes it on the
  // first run and replaces with /cellars on the second — the fix would work in
  // production and silently not in dev. Same trap VerifyEmail.js guards.
  stashPostLoginRedirect('/wishlist');
  render(<StrictMode><OAuthCallback /></StrictMode>);
  expect(navigateMock).toHaveBeenLastCalledWith('/wishlist', { replace: true });
});
