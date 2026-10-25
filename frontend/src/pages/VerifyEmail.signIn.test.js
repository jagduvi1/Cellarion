/**
 * The verification link signs the member in when it opens in the browser that
 * registered the account (the server decides, via its signup binding cookie);
 * anywhere else it verifies and sends them to the login page, as before.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import VerifyEmail from './VerifyEmail';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));

const navigateMock = vi.fn();
const setSearchParamsMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams('?token=tok-1'), setSearchParamsMock],
}));

const verifyEmailMock = vi.fn();
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ verifyEmail: verifyEmailMock }),
}));
vi.mock('../components/AuthLogo', () => ({ default: () => null }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  navigateMock.mockReset();
  setSearchParamsMock.mockReset();
  verifyEmailMock.mockReset();
});
afterEach(() => vi.useRealTimers());

test('signed in by the verification: says so and goes to the cellar', async () => {
  verifyEmailMock.mockResolvedValue({ success: true, signedIn: true });
  render(<VerifyEmail />);

  expect(await screen.findByText(/You're signed in/)).toBeInTheDocument();
  expect(verifyEmailMock).toHaveBeenCalledWith('tok-1');
  await act(async () => { vi.advanceTimersByTime(1600); });
  expect(navigateMock).toHaveBeenCalledWith('/cellars', { replace: true });
});

test('verified but not signed in (another browser): goes to the login page', async () => {
  verifyEmailMock.mockResolvedValue({ success: true, signedIn: false });
  render(<VerifyEmail />);

  expect(await screen.findByText('auth.verified')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(1600); });
  expect(navigateMock).toHaveBeenCalledWith('/login', { replace: true, state: { verified: true } });
});

test('a failed verification shows the error and does not navigate', async () => {
  verifyEmailMock.mockResolvedValue({ success: false, error: 'Invalid or expired verification token' });
  render(<VerifyEmail />);

  expect(await screen.findByText('Invalid or expired verification token')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(1600); });
  await waitFor(() => expect(navigateMock).not.toHaveBeenCalled());
});
