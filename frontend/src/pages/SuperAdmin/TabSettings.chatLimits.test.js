import { render, screen, fireEvent, within } from '@testing-library/react';
import TabSettings from './TabSettings';

// The Cellar Chat panel offers the two burst settings the backend enforces
// (requests per window, and the window) and nothing else: chat answers in one
// request, so there is no stream to cap or time out. The panel needs only the
// chatBurst group from GET /rate-limits, and its Save sends only that group.

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const reply = (body, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });

// What GET /api/admin/settings/rate-limits answers: no chatConcurrentStreams.
const CONFIG = {
  api: { max: 200 }, write: { max: 60 }, auth: { max: 10 },
  accountLockout: { threshold: 10, windowMs: 900000, durationMs: 3600000, emailDedupMs: 3600000 },
  chatBurst: { max: 5, windowMs: 60000 },
  aiDailyBudget: { max: 500 }, aiImportPerRequestCap: { max: 50 }, aiGlobalDailyCap: { max: 20000 },
  registryRead: { anonymousDailyDistinct: 300, memberAlertDistinct: 1000 },
  bridge: { enabled: 1, searches: 600, fetches: 300, changeChecks: 1, contributions: 50, burstPerMinute: 60 },
  mcp: { enabled: 1, publicEnabled: 1, userMax: 300, ipMax: 5000, registerMax: 200, oauthMax: 2000 },
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((url, init) => {
    if (url === '/api/admin/settings/rate-limits') {
      return init?.method === 'PATCH' ? reply({ config: CONFIG }) : reply({ config: CONFIG, defaults: CONFIG });
    }
    if (url === '/api/admin/settings/new-member-emails') {
      return reply({ enabled: false, since: null, mailConfigured: true, sentLast30Days: { cellar: 0, empty: 0 } });
    }
    return reply({});
  });
});

const chatPanel = async () => (await screen.findByText('Cellar Chat abuse controls')).closest('.sa-panel');

test('shows the two burst settings from the chatBurst group alone', async () => {
  render(<TabSettings />);
  const panel = await chatPanel();

  expect(within(panel).getByText('Burst limit — requests')).toBeInTheDocument();
  expect(within(panel).getByText('Burst limit — window')).toBeInTheDocument();
  expect(within(panel).getAllByRole('spinbutton').map(i => i.value)).toEqual(['5', '60000']);
  expect(within(panel).queryByText(/concurrent/i)).not.toBeInTheDocument();
  expect(within(panel).queryByText(/SSE|stream/i)).not.toBeInTheDocument();
});

test('Save sends only the chatBurst group', async () => {
  render(<TabSettings />);
  const panel = await chatPanel();

  const [, windowInput] = within(panel).getAllByRole('spinbutton');
  fireEvent.change(windowInput, { target: { value: '120000' } });
  fireEvent.click(within(panel).getByText('Save'));

  expect(await within(panel).findByText('Saved — takes effect immediately')).toBeInTheDocument();
  const patches = apiFetch.mock.calls.filter(([url, init]) => url === '/api/admin/settings/rate-limits' && init?.method === 'PATCH');
  expect(patches).toHaveLength(1);
  expect(JSON.parse(patches[0][1].body)).toEqual({ chatBurst: { max: 5, windowMs: 120000 } });
});
