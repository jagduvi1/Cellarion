import { render, screen } from '@testing-library/react';
import RegistryConnectionSection from './RegistryConnectionSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      if (typeof fallback !== 'string') return key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] !== undefined ? String(vars[k]) : ''));
    },
  }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const ok = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

beforeEach(() => apiFetch.mockReset());

describe('RegistryConnectionSection (self-hosted Settings card)', () => {
  test('a connected install sees the key prefix, copies held, quota use and the last refresh', async () => {
    apiFetch.mockImplementation(() => ok({
      enabled: true, reason: null, url: 'https://cellarion.app', keyPrefix: 'cbr_12345678', blocked: null, lastError: null,
      held: 42, removed: 1, lastRefresh: { at: '2026-09-08T06:30:00Z', updated: 3, removed: 1 },
      me: { usage: { used: { searches: 12, fetches: 4 }, caps: { searches: 600, fetches: 300 }, importWindow: { active: true } } },
    }));
    render(<RegistryConnectionSection />);
    expect(screen.getByRole('heading', { name: /Shared wine registry/ })).toBeInTheDocument();
    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
    expect(screen.getByText(/cbr_12345678/)).toBeInTheDocument();
    expect(screen.getByText(/42 wines copied from the registry/)).toBeInTheDocument();
    expect(screen.getByText(/1 no longer in the registry/)).toBeInTheDocument();
    expect(screen.getByText(/3 updated, 1 removed/)).toBeInTheDocument();
    expect(screen.getByText(/Today: 12\/600 searches · 4\/300 wines copied · import window open/)).toBeInTheDocument();
    expect(screen.queryByText(/Not connected/)).toBeNull();
  });

  test('a backing-off install says why and until when', async () => {
    apiFetch.mockImplementation(() => ok({ enabled: true, url: 'https://cellarion.app', keyPrefix: 'cbr_12345678', blocked: { reason: 'quota', until: '2026-09-08T12:00:00Z' }, lastError: { code: 'quota' }, held: 0, removed: 0, lastRefresh: null, me: null }));
    render(<RegistryConnectionSection />);
    expect(await screen.findByText(/The registry answered "quota"/)).toBeInTheDocument();
    expect(screen.getByText(/Copies refresh weekly on Monday mornings/)).toBeInTheDocument();
  });

  test('an unconnected install gets the reason and the three steps, with links to the hosted settings and the docs', async () => {
    apiFetch.mockImplementation(() => ok({ enabled: false, reason: 'no_key', url: 'https://cellarion.app', keyPrefix: null, blocked: null, lastError: null, held: 0, removed: 0, lastRefresh: null, me: null }));
    render(<RegistryConnectionSection />);
    expect(await screen.findByText(/Not connected/)).toBeInTheDocument();
    expect(screen.getByText(/No bridge key is configured on this server/)).toBeInTheDocument();
    expect(screen.getByText(/Put the two lines into this server's \.env/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open cellarion\.app settings/ })).toHaveAttribute('href', 'https://cellarion.app/settings');
    expect(screen.getByRole('link', { name: /How the bridge works/ })).toHaveAttribute('href', expect.stringContaining('docs/registry-bridge.md'));
  });

  test('a misconfigured key names the mistake', async () => {
    apiFetch.mockImplementation(() => ok({ enabled: false, reason: 'self_target', url: 'https://cellar.example.org', held: 0, removed: 0 }));
    render(<RegistryConnectionSection />);
    expect(await screen.findByText(/points at this very install/)).toBeInTheDocument();
  });
});
