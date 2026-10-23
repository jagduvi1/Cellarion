import { render, screen, fireEvent } from '@testing-library/react';
import { NewMemberEmailsPanel } from './TabSettings';

// The switch for the one email a new member gets two days after joining
// (backend services/newMemberEmails): off by default, and turning it on is
// what decides from when accounts can get one.
const reply = (body, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });

test('shows that it is off and turns it on', async () => {
  const apiFetch = vi.fn()
    .mockReturnValueOnce(reply({ enabled: false, since: null, mailConfigured: true, sentLast30Days: { cellar: 0, empty: 0 } }))
    .mockReturnValueOnce(reply({ enabled: true, since: '2026-10-24T09:00:00.000Z' }));
  render(<NewMemberEmailsPanel apiFetch={apiFetch} />);

  expect(await screen.findByText('Off')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Turn on'));

  expect(await screen.findByText('Turned on')).toBeInTheDocument();
  expect(screen.getByText(/^On since/)).toBeInTheDocument();
  expect(screen.getByText('Turn off')).toBeInTheDocument();
  const [url, init] = apiFetch.mock.calls[1];
  expect(url).toBe('/api/admin/settings/new-member-emails');
  expect(init.method).toBe('PATCH');
  expect(JSON.parse(init.body)).toEqual({ enabled: true });
});

test('shows what went out, and warns when mail is not set up', async () => {
  const apiFetch = vi.fn().mockReturnValueOnce(reply({
    enabled: true, since: '2026-10-24T09:00:00.000Z', mailConfigured: false, sentLast30Days: { cellar: 7, empty: 4 },
  }));
  render(<NewMemberEmailsPanel apiFetch={apiFetch} />);

  expect(await screen.findByText('7 cellar · 4 empty')).toBeInTheDocument();
  expect(screen.getByText('Not configured: nothing is sent')).toBeInTheDocument();
});

test('a refused change says why and keeps the state', async () => {
  const apiFetch = vi.fn()
    .mockReturnValueOnce(reply({ enabled: false, since: null, mailConfigured: true, sentLast30Days: { cellar: 0, empty: 0 } }))
    .mockReturnValueOnce(reply({ error: 'enabled must be true or false' }, false));
  render(<NewMemberEmailsPanel apiFetch={apiFetch} />);

  fireEvent.click(await screen.findByText('Turn on'));

  expect(await screen.findByText('enabled must be true or false')).toBeInTheDocument();
  expect(screen.getByText('Off')).toBeInTheDocument();
});
