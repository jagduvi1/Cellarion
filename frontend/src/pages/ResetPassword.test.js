import { render, screen, fireEvent } from '@testing-library/react';
import ResetPassword from './ResetPassword';

// The reset page says what went wrong in the person's language: a weak
// password before anything is sent (the server's refusal is English), and a
// spent link by its error code's translation.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Keys read as keys; one error code has a translation.
    t: (key, opts) => (key === 'errors.codes.reset_token_invalid'
      ? 'Lenken er ugyldig eller utløpt.'
      : typeof opts === 'object' && 'defaultValue' in opts ? opts.defaultValue : key),
  }),
}));
const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams('token=abc'), vi.fn()],
}));
vi.mock('../components/AuthLogo', () => ({ default: () => null }));

const STRONG = 'Correct-horse-9-battery';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });

function submit(password, confirm = password) {
  fireEvent.change(screen.getByLabelText('auth.newPassword'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('auth.confirmPassword'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: /auth\./ }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

test('a weak password is refused before anything is sent', () => {
  render(<ResetPassword />);
  submit('short');
  expect(screen.getByText('auth.passwordRuleError')).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

test('a spent link is explained by its code, in translation', async () => {
  fetch.mockResolvedValue(json(400, { error: 'Invalid or expired reset token', code: 'reset_token_invalid' }));
  render(<ResetPassword />);
  submit(STRONG);
  expect(await screen.findByText('Lenken er ugyldig eller utløpt.')).toBeInTheDocument();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'abc', password: STRONG });
});

test("a refusal without a translated code keeps the server's words", async () => {
  fetch.mockResolvedValue(json(400, { error: 'Password must not contain your username' }));
  render(<ResetPassword />);
  submit(STRONG);
  expect(await screen.findByText('Password must not contain your username')).toBeInTheDocument();
});
