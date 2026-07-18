import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SetPasswordNotice from './SetPasswordNotice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
  }),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'somm@cellarion.app', hasPassword: false } }),
}));

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('SetPasswordNotice', () => {
  test('explains the missing password and offers the email link', () => {
    render(<SetPasswordNotice />);
    expect(screen.getByText(/no password yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set-password link/i })).toBeInTheDocument();
  });

  test('custom text overrides the default explanation', () => {
    render(<SetPasswordNotice text="Custom explanation" />);
    expect(screen.getByText('Custom explanation')).toBeInTheDocument();
    expect(screen.queryByText(/asks for one as extra confirmation/i)).not.toBeInTheDocument();
  });

  test('emails the reset link for the signed-in account and shows the sent state', async () => {
    fetch.mockResolvedValue({ ok: true });
    render(<SetPasswordNotice />);
    fireEvent.click(screen.getByRole('button', { name: /set-password link/i }));
    await waitFor(() => expect(screen.getByText(/check your inbox/i)).toBeInTheDocument());
    // Uses the SAME forgot-password flow as the login page — inbox control,
    // not this session, is what mints the first password.
    expect(fetch).toHaveBeenCalledWith('/api/auth/forgot-password', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'somm@cellarion.app' }),
    }));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('shows an error state when the request fails, button stays for retry', async () => {
    fetch.mockRejectedValue(new Error('network'));
    render(<SetPasswordNotice />);
    fireEvent.click(screen.getByRole('button', { name: /set-password link/i }));
    await waitFor(() => expect(screen.getByText(/could not send/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /set-password link/i })).toBeInTheDocument();
  });
});
