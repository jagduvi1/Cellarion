import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AdminMcp from './AdminMcp';

// The bug this suite exists for (grand-audit H1): the page stored the raw
// Response as `data`, so `byDay(data.daily)` iterated undefined and crashed the
// whole app on every load. These tests drive the real parse path.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts && opts.count !== undefined ? `${key}:${opts.count}` : key) }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const getUsage = vi.fn();
const setSwitches = vi.fn();
vi.mock('../api/admin', () => ({
  adminGetMcpUsage: (...a) => getUsage(...a),
  adminSetMcpSwitches: (...a) => setSwitches(...a),
}));

const jsonRes = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

const USAGE = {
  days: 30,
  daily: [{ day: '2026-07-15T00:00:00.000Z', surface: 'personal', calls: 41, errors: 2 }],
  topTools: [
    { name: 'search_bottles', surface: 'personal', calls: 20, errors: 1, errorCodes: { invalid_input: 1 } },
    // No errorCodes at all — the shape every row had before the field existed.
    { name: 'get_wine', surface: 'public', calls: 9, errors: 0 },
  ],
  connections: { bearer: { total: 3, activeLast7d: 2 }, oauth: { total: 5, activeLast7d: 4 } },
  users: { connected: 7, oauthConnected: 4, oauthActiveLast7d: 3, wroteLast7d: 2 },
  writesLast7d: 12,
  mcpConfig: { enabled: 1, publicEnabled: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  getUsage.mockResolvedValue(jsonRes(USAGE));
  setSwitches.mockResolvedValue(jsonRes({}));
});

test('parses the usage payload and renders it without crashing', async () => {
  render(<AdminMcp />);
  // The daily row must appear — proving byDay() ran over parsed data, not a Response.
  await waitFor(() => expect(screen.getByText('2026-07-15')).toBeInTheDocument());
  expect(screen.getByText('search_bottles')).toBeInTheDocument();
});

test('renders the distinct-user counts next to the connection counts', async () => {
  render(<AdminMcp />);
  // 8 connections (3 bearer + 5 oauth) but 7 users — both must be on screen, so
  // "connections" can never be misread as "people".
  await waitFor(() => expect(screen.getByText('8')).toBeInTheDocument());
  expect(screen.getByText('7')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
  expect(screen.getByText('adminMcp.usersSplit')).toBeInTheDocument();
  expect(screen.getByText('adminMcp.usersNote')).toBeInTheDocument();
});

test('survives a payload with no users block (older backend)', async () => {
  const withoutUsers = { ...USAGE };
  delete withoutUsers.users;
  getUsage.mockResolvedValue(jsonRes(withoutUsers));
  render(<AdminMcp />);
  // Renders em-dashes rather than crashing on users.connected.
  await waitFor(() => expect(screen.getByText('2026-07-15')).toBeInTheDocument());
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
});

test('shows WHY a tool failed, and renders rows that carry no errorCodes at all', async () => {
  render(<AdminMcp />);
  await waitFor(() => expect(screen.getByText('search_bottles')).toBeInTheDocument());
  // The breakdown is the point — a bare "1" cannot be acted on.
  expect(screen.getByText('invalid_input 1')).toBeInTheDocument();
  // The pre-field row still renders (no crash on a missing map).
  expect(screen.getByText('get_wine')).toBeInTheDocument();
});

test('surfaces a server error instead of blanking', async () => {
  getUsage.mockResolvedValue(jsonRes({ error: 'Failed to load MCP usage' }, false));
  render(<AdminMcp />);
  await waitFor(() => expect(screen.getByText('Failed to load MCP usage')).toBeInTheDocument());
});

test('a rejected kill-switch PATCH does not flip the UI (reports the error)', async () => {
  setSwitches.mockResolvedValue(jsonRes({ error: 'nope' }, false));
  const { container } = render(<AdminMcp />);
  await waitFor(() => expect(screen.getByText('2026-07-15')).toBeInTheDocument());
  const master = container.querySelector('input[type="checkbox"]');
  expect(master.checked).toBe(true);
  fireEvent.click(master);
  await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
  // Still on (server rejected) — no false "disabled" state.
  expect(master.checked).toBe(true);
});
