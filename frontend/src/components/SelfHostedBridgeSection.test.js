import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SelfHostedBridgeSection from './SelfHostedBridgeSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Components pass English fallbacks inline — return those (with the
    // {{placeholders}} filled) so assertions read like the real UI.
    t: (key, fallback, vars) => {
      if (typeof fallback !== 'string') return key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] !== undefined ? String(vars[k]) : ''));
    },
  }),
}));

const apiFetch = vi.fn();
const authState = { apiFetch, user: { hasPassword: true } };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));

const ok = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const KEY = { id: 'k1', name: 'Home NAS', prefix: 'cbr_12345678', instanceHost: 'cellar.example.org', createdAt: '2026-09-08T00:00:00Z', lastUsedAt: null, usage: { used: { searches: 12, fetches: 3 }, caps: { searches: 600, fetches: 300 }, importWindow: { active: false } } };
const list = (keys, accepted) => ({ keys, maxActive: 2, terms: { version: '2026-09', accepted, url: '/terms' } });

const renderSection = () => render(<MemoryRouter><SelfHostedBridgeSection /></MemoryRouter>);

beforeEach(() => {
  apiFetch.mockReset();
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(() => { delete window.navigator.clipboard; });

describe('SelfHostedBridgeSection', () => {
  test('lists the account\'s keys with prefix, host and today\'s usage, and links the terms', async () => {
    apiFetch.mockImplementation((url) => (url === '/api/bridge/keys' ? ok(list([KEY], true)) : ok({})));
    renderSection();
    expect(screen.getByRole('heading', { name: /Connect a self-hosted Cellarion/ })).toBeInTheDocument();
    expect(await screen.findByText('Home NAS')).toBeInTheDocument();
    expect(screen.getByText(/cbr_12345678/)).toBeInTheDocument();
    expect(screen.getByText(/cellar\.example\.org/)).toBeInTheDocument();
    expect(screen.getByText(/Today: 12\/600 searches · 3\/300 wines/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Registry Data Terms/ })).toHaveAttribute('href', '/terms');
  });

  test('creating a key asks for the terms when not yet accepted, then shows the two .env lines once', async () => {
    apiFetch.mockImplementation((url, opts = {}) => {
      if (url === '/api/bridge/keys' && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        expect(body).toEqual({ name: 'Home NAS', password: 'pw', acceptTerms: true });
        return ok({ key: 'cbr_' + 'a'.repeat(64), id: 'k1', name: 'Home NAS', prefix: 'cbr_aaaaaaaa', env: { REGISTRY_BRIDGE_URL: 'https://cellarion.app', REGISTRY_BRIDGE_KEY: 'cbr_' + 'a'.repeat(64) } }, 201);
      }
      return ok(list([], false));
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /Create bridge key/ }));
    fireEvent.change(screen.getByLabelText(/Name of the install/), { target: { value: 'Home NAS' } });
    fireEvent.change(screen.getByLabelText(/Confirm with your password/), { target: { value: 'pw' } });
    // Terms box unticked → refused client-side, no request made.
    fireEvent.click(screen.getByRole('button', { name: /^Create key$/ }));
    expect(await screen.findByText(/Accept the Registry Data Terms/)).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([, o]) => o && o.method === 'POST')).toHaveLength(0);

    fireEvent.click(screen.getByLabelText(/I accept the Registry Data Terms/));
    fireEvent.click(screen.getByRole('button', { name: /^Create key$/ }));
    const shown = await screen.findByText(/REGISTRY_BRIDGE_KEY=cbr_a+/);
    expect(shown.textContent).toContain('REGISTRY_BRIDGE_URL=https://cellarion.app');
    expect(screen.getByText(/will not be shown again/)).toBeInTheDocument();
  });

  test('a wrong password is reported as such (403), not as a session problem', async () => {
    apiFetch.mockImplementation((url, opts = {}) => (opts.method === 'POST' ? ok({ error: 'Password is incorrect' }, 403) : ok(list([], true))));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /Create bridge key/ }));
    fireEvent.change(screen.getByLabelText(/Name of the install/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/Confirm with your password/), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create key$/ }));
    expect(await screen.findByText(/Your password is incorrect/)).toBeInTheDocument();
  });

  test('two keys is the cap: the create button is disabled and says so; revoke confirms then calls the API', async () => {
    apiFetch.mockImplementation((url, opts = {}) => {
      if (opts.method === 'DELETE') return ok({ message: 'revoked' });
      return ok(list([KEY, { ...KEY, id: 'k2', name: 'Club cellar' }], true));
    });
    renderSection();
    expect(await screen.findByText('Club cellar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create bridge key/ })).toBeDisabled();
    expect(screen.getByText(/Two keys per account/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Revoke$/ })[0]);
    expect(await screen.findByText(/Revoke "Home NAS"\?/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Revoke$/ }).pop());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/bridge/keys/k1', { method: 'DELETE' }));
  });
});
