import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConnectAiAuthorize from './ConnectAiAuthorize';

// t returns the inline English fallback (repo convention).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));

let searchParams;
vi.mock('react-router-dom', () => ({ useSearchParams: () => [searchParams] }));

let authState;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));

const approveMock = vi.fn();
vi.mock('../api/mcp', () => ({ approveOAuthConnection: (...args) => approveMock(...args) }));

const VALID = {
  client_id: 'mcpc_abc',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  scope: 'read write',
  state: 'xyz',
  resource: 'https://cellarion.app/api/mcp',
  client_name: 'Claude',
};

beforeEach(() => {
  searchParams = new URLSearchParams(VALID);
  authState = { user: { isDemo: false }, loading: false, apiFetch: vi.fn(), login: vi.fn() };
  approveMock.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
});

test('an incomplete request shows an error and no consent', () => {
  searchParams = new URLSearchParams({ client_id: 'mcpc_abc' }); // missing redirect_uri + PKCE
  render(<ConnectAiAuthorize />);
  expect(screen.getByText(/invalid or incomplete/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
});

test('logged out → inline login form (OAuth params are NOT lost to a redirect)', () => {
  authState.user = null;
  render(<ConnectAiAuthorize />);
  expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Username or email')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
});

test('a demo user is told to make a real account', () => {
  authState.user = { isDemo: true };
  render(<ConnectAiAuthorize />);
  expect(screen.getByText(/not available in the demo/i)).toBeInTheDocument();
});

test('the consent screen is labelled Beta and says it is used at your own risk', () => {
  render(<ConnectAiAuthorize />);
  // The badge rides in the heading, so it lands in the accessible name too.
  expect(screen.getByRole('heading', { name: /Connect your AI assistant\s+Beta/ })).toBeInTheDocument();
  expect(screen.getByText(/beta feature and you use it at your own risk/i)).toBeInTheDocument();
});

test('logged in → shows the client name, requested scopes, and the return host', () => {
  render(<ConnectAiAuthorize />);
  expect(screen.getByRole('heading', { name: /Connect your AI assistant/ })).toBeInTheDocument();
  expect(screen.getByText('Claude')).toBeInTheDocument();
  // read + write requested → both described (across the level options);
  // consume NOT requested → neither its description nor its level appears.
  expect(screen.getAllByText(/View your cellars/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/add and edit bottles/i).length).toBeGreaterThan(0);
  expect(screen.queryByText(/Mark bottles as opened/i)).not.toBeInTheDocument();
  expect(screen.getByText('claude.ai')).toBeInTheDocument(); // return host, transparency
});

test('approving posts the consent and navigates to the returned redirect', async () => {
  approveMock.mockResolvedValue({ ok: true, json: async () => ({ redirect: 'https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz' }) });
  render(<ConnectAiAuthorize />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

  await waitFor(() => expect(window.location.href).toBe('https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz'));
  // The consent decision carried the OAuth request params + approved:true.
  const body = approveMock.mock.calls[0][1];
  expect(body).toMatchObject({
    client_id: 'mcpc_abc',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: VALID.code_challenge,
    scope: 'read write',
    state: 'xyz',
    approved: true,
  });
});

test('denying sends approved:false and still follows the returned redirect', async () => {
  approveMock.mockResolvedValue({ ok: true, json: async () => ({ redirect: 'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=xyz' }) });
  render(<ConnectAiAuthorize />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(window.location.href).toContain('error=access_denied'));
  expect(approveMock.mock.calls[0][1].approved).toBe(false);
});

test('a backend failure shows an error and does not navigate', async () => {
  approveMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'boom' }) });
  render(<ConnectAiAuthorize />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

  await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  expect(window.location.href).toBe('');
});

// ── The scope picker (read/consume/write choice at consent) ─────────────────
test('defaults to full offered access and posts the full scope set', async () => {
  approveMock.mockResolvedValue({ ok: true, json: async () => ({ redirect: 'https://claude.ai/cb' }) });
  render(<ConnectAiAuthorize />);
  // scope 'read write' → two levels, full pre-selected.
  const radios = screen.getAllByRole('radio');
  expect(radios).toHaveLength(2);
  expect(radios[1]).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(approveMock).toHaveBeenCalled());
  expect(approveMock.mock.calls[0][1].scopes).toEqual(['read', 'write']);
});

test('choosing "Read only" narrows the grant to just read', async () => {
  approveMock.mockResolvedValue({ ok: true, json: async () => ({ redirect: 'https://claude.ai/cb' }) });
  render(<ConnectAiAuthorize />);
  fireEvent.click(screen.getByLabelText(/Read only/i));
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(approveMock).toHaveBeenCalled());
  expect(approveMock.mock.calls[0][1].scopes).toEqual(['read']);
});

test('a full read+consume+write request renders three levels', () => {
  searchParams = new URLSearchParams({ ...VALID, scope: 'read consume write' });
  render(<ConnectAiAuthorize />);
  expect(screen.getAllByRole('radio')).toHaveLength(3);
  expect(screen.getByLabelText(/Full access/i)).toBeChecked();
});

test('denying does not send a scopes field at all', async () => {
  approveMock.mockResolvedValue({ ok: true, json: async () => ({ redirect: 'https://claude.ai/cb?error=access_denied' }) });
  render(<ConnectAiAuthorize />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(approveMock).toHaveBeenCalled());
  expect(approveMock.mock.calls[0][1]).not.toHaveProperty('scopes');
});
