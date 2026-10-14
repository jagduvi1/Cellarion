/**
 * The first minutes of a new account: "Create account" buttons land on the
 * Register form, the account rules are said before submitting (in the user's
 * language, not as an English server refusal), a trailing space from a phone
 * keyboard is not part of the name, and the email-verified hop explains itself.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Login from './Login';

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
  useSearchParams: () => [new URLSearchParams(routerLocation.search)],
}));

const loginMock = vi.fn();
const registerMock = vi.fn();
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ login: loginMock, register: registerMock }),
}));

vi.mock('../hooks/useVersion', () => ({ default: () => null }));

const GOOD_PASSWORD = 'Correct-horse-9';

beforeEach(() => {
  window.sessionStorage.clear();
  navigateMock.mockReset();
  routerLocation = { pathname: '/login', search: '', state: null };
  loginMock.mockReset().mockResolvedValue({ success: true });
  registerMock.mockReset().mockResolvedValue({ success: true, requiresVerification: true, email: 'anna@example.com' });
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ google: false }) });
});

const submit = () => fireEvent.click(document.querySelector('form button[type="submit"]'));

const fillRegister = ({ username = 'anna', email = 'anna@example.com', password = GOOD_PASSWORD } = {}) => {
  fireEvent.change(screen.getByLabelText('auth.usernameLabel'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('auth.emailLabel'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('auth.passwordLabel'), { target: { value: password } });
  fireEvent.click(screen.getByRole('checkbox'));
};

test('?mode=register opens the Register form, with the account rules shown up front', () => {
  routerLocation.search = '?mode=register';
  render(<Login />);
  expect(screen.getByLabelText('auth.emailLabel')).toBeInTheDocument();
  expect(screen.getByText(/3–30 characters/)).toBeInTheDocument();
  expect(screen.getByLabelText('auth.passwordLabel')).toHaveAccessibleDescription(/at least 12 characters/i);
});

test('a plain /login still opens the sign-in form', () => {
  render(<Login />);
  expect(screen.getByLabelText('auth.usernameOrEmail')).toBeInTheDocument();
  expect(screen.queryByLabelText('auth.emailLabel')).not.toBeInTheDocument();
});

test('a password that breaks the rule is explained before anything is sent', async () => {
  routerLocation.search = '?mode=register';
  render(<Login />);
  fillRegister({ password: 'short' });
  submit();
  expect(await screen.findByRole('alert')).toHaveTextContent(/needs at least 12 characters/);
  expect(registerMock).not.toHaveBeenCalled();
});

test('a username with a space is explained before anything is sent', async () => {
  routerLocation.search = '?mode=register';
  render(<Login />);
  fillRegister({ username: 'Anna Svensson' });
  submit();
  expect(await screen.findByRole('alert')).toHaveTextContent(/no spaces/);
  expect(registerMock).not.toHaveBeenCalled();
});

test('registers with the trailing keyboard space trimmed', async () => {
  routerLocation.search = '?mode=register';
  render(<Login />);
  fillRegister({ username: 'anna ', email: 'anna@example.com ' });
  submit();
  await waitFor(() => expect(registerMock).toHaveBeenCalledWith('anna', 'anna@example.com', GOOD_PASSWORD, true));
});

test('a taken username or email says what to try next, without saying which', async () => {
  routerLocation.search = '?mode=register';
  registerMock.mockResolvedValue({ success: false, error: 'Registration failed. Please check your details and try again.', code: 'REGISTRATION_REJECTED' });
  render(<Login />);
  fillRegister();
  submit();
  expect(await screen.findByRole('alert')).toHaveTextContent(/log in or reset your password/);
});

test('signs in with the trailing keyboard space trimmed', async () => {
  render(<Login />);
  fireEvent.change(screen.getByLabelText('auth.usernameOrEmail'), { target: { value: 'anna@example.com ' } });
  fireEvent.change(screen.getByLabelText('auth.passwordLabel'), { target: { value: 'whatever' } });
  submit();
  await waitFor(() => expect(loginMock).toHaveBeenCalledWith('anna@example.com', 'whatever', true));
});

test('arriving from a verified email link says what is left to do', () => {
  routerLocation.state = { verified: true };
  render(<Login />);
  expect(screen.getByRole('status')).toHaveTextContent(/email is verified/i);
});
