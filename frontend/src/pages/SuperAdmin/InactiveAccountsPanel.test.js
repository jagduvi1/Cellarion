import { render, screen, fireEvent } from '@testing-library/react';
import InactiveAccountsPanel from './InactiveAccountsPanel';

// The switch for deleting accounts nobody uses (backend services/inactiveAccounts):
// off by default, and before turning it on the admin sees what it would do today.
const reply = (body, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });

const OFF = {
  enabled: false, since: null, mailConfigured: true,
  trackedSince: '2026-11-01T00:00:00.000Z', earliestDeletion: '2027-11-01T00:00:00.000Z',
  rule: { monthsWithContent: 24, monthsEmpty: 12, firstNoticeDays: 30, finalNoticeDays: 7 },
  today: { first: 3, final: 1, delete: 0, exempt: 5 },
  onTimeline: 4,
  last30Days: { firstNotices: 0, finalNotices: 0, deleted: 0 },
};

test('shows the rule and what it would do today, then turns it on', async () => {
  const apiFetch = vi.fn()
    .mockReturnValueOnce(reply(OFF))
    .mockReturnValueOnce(reply({ enabled: true, since: '2026-11-01T09:00:00.000Z' }));
  render(<InactiveAccountsPanel apiFetch={apiFetch} />);

  expect(await screen.findByText('Off')).toBeInTheDocument();
  expect(screen.getByText(/nobody has used for 24 months \(12 months when they never/)).toBeInTheDocument();
  expect(screen.getByText(/3 first notices · 1 final notices · 0 deletions/)).toBeInTheDocument();
  expect(screen.getByText(/5 exempt · 4 accounts on a timeline in all/)).toBeInTheDocument();

  fireEvent.click(screen.getByText('Turn on'));

  expect(await screen.findByText('Turned on')).toBeInTheDocument();
  expect(screen.getByText(/^On since/)).toBeInTheDocument();
  const [url, init] = apiFetch.mock.calls[1];
  expect(url).toBe('/api/admin/settings/inactive-accounts');
  expect(init.method).toBe('PATCH');
  expect(JSON.parse(init.body)).toEqual({ enabled: true });
});

test('warns that nothing runs while mail is not set up', async () => {
  const apiFetch = vi.fn().mockReturnValueOnce(reply({ ...OFF, mailConfigured: false }));
  render(<InactiveAccountsPanel apiFetch={apiFetch} />);
  expect(await screen.findByText(/Not configured: nothing runs/)).toBeInTheDocument();
});

test('a refused change says why and keeps the state', async () => {
  const apiFetch = vi.fn()
    .mockReturnValueOnce(reply(OFF))
    .mockReturnValueOnce(reply({ error: 'enabled must be true or false' }, false));
  render(<InactiveAccountsPanel apiFetch={apiFetch} />);

  fireEvent.click(await screen.findByText('Turn on'));

  expect(await screen.findByText('enabled must be true or false')).toBeInTheDocument();
  expect(screen.getByText('Off')).toBeInTheDocument();
});

test('shows from when use is recorded and the earliest possible deletion', async () => {
  const apiFetch = vi.fn().mockReturnValueOnce(reply(OFF));
  render(<InactiveAccountsPanel apiFetch={apiFetch} />);
  expect(await screen.findByText('Use recorded since')).toBeInTheDocument();
  expect(screen.getByText(/account can be deleted before/))
    .toHaveTextContent(new Date('2027-11-01T00:00:00.000Z').toLocaleDateString());
});

test('a failed load shows the error and no switch', async () => {
  const apiFetch = vi.fn().mockReturnValueOnce(reply({ error: 'Admin access required' }, false));
  render(<InactiveAccountsPanel apiFetch={apiFetch} />);
  expect(await screen.findByText('Admin access required')).toBeInTheDocument();
  expect(screen.queryByText('Turn on')).not.toBeInTheDocument();
});

test('an error page that is not JSON reads as a failed load, not a parser error', async () => {
  const apiFetch = vi.fn().mockReturnValueOnce(Promise.resolve({ ok: false, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }));
  render(<InactiveAccountsPanel apiFetch={apiFetch} />);
  expect(await screen.findByText('Failed to load')).toBeInTheDocument();
});
