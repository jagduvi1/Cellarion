import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SupportPage from './SupportPage';

// The person who opened a ticket can close it themselves once it is answered
// or the problem went away. Closing is final for them (a closed ticket takes
// no more replies), so it goes through a confirmation.

// The inline English default with {{vars}} filled in, else the key.
vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const text = typeof a === 'string' ? a : key;
    const vars = (typeof a === 'object' && a) || (typeof b === 'object' && b) || {};
    return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
  };
  return { useTranslation: () => ({ t }) };
});

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const getTickets = vi.fn();
const getReports = vi.fn();
const reply = vi.fn();
const close = vi.fn();
vi.mock('../api/support', () => ({
  getMySupportTickets: (...a) => getTickets(...a),
  getMyWineReports: (...a) => getReports(...a),
  replySupportTicket: (...a) => reply(...a),
  closeSupportTicket: (...a) => close(...a),
}));

const jsonRes = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

const TICKET = {
  _id: 't1',
  subject: 'Import stuck at 80%',
  message: 'The import never finishes.',
  category: 'bug',
  status: 'in_progress',
  createdAt: '2026-10-01T08:00:00.000Z',
  replies: [{ author: 'admin', message: 'Fixed in today\'s release.', createdAt: '2026-10-02T08:00:00.000Z' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getTickets.mockResolvedValue(jsonRes({ tickets: [TICKET] }));
  getReports.mockResolvedValue(jsonRes({ reports: [] }));
});

// In a router: the page links to Help.
const renderPage = () => render(<MemoryRouter><SupportPage /></MemoryRouter>);

async function openTicket() {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /Import stuck at 80%/ }));
}

// Most questions are answered in Help, which nobody found (usability plan,
// Step 6): the Support page points there before the ticket list.
test('points to Help first', async () => {
  renderPage();
  expect(screen.getByText(/Look in Help first/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open Help' })).toHaveAttribute('href', '/help');
  // The ticket button stays where it was.
  expect(screen.getByRole('button', { name: 'support.newTicket' })).toBeInTheDocument();
  await screen.findByRole('button', { name: /Import stuck at 80%/ });
});

test('"Mark as resolved" asks first, then closes the ticket and the reply box gives way to the closed note', async () => {
  close.mockResolvedValue(jsonRes({ ticket: { ...TICKET, status: 'closed' } }));
  await openTicket();

  fireEvent.click(screen.getByRole('button', { name: 'Mark as resolved' }));
  expect(close).not.toHaveBeenCalled();
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/Import stuck at 80%/)).toBeInTheDocument();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as resolved' }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(apiFetch, 't1'));
  expect(await screen.findByText(/This ticket is closed/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Mark as resolved' })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('with a reply typed but not sent, the confirmation says it will not be sent', async () => {
  await openTicket();
  fireEvent.click(screen.getByRole('button', { name: 'Mark as resolved' }));
  expect(within(await screen.findByRole('dialog')).queryByText(/will not be sent/)).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'One more thing…' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark as resolved' }));
  expect(within(await screen.findByRole('dialog')).getByText('The reply you have written will not be sent.')).toBeInTheDocument();
});

test('cancelling the confirmation leaves the ticket open', async () => {
  await openTicket();
  fireEvent.click(screen.getByRole('button', { name: 'Mark as resolved' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Mark as resolved' })).toBeInTheDocument();
});

test('a refused close shows the reason and keeps the ticket open', async () => {
  close.mockResolvedValue(jsonRes({ error: 'Ticket not found' }, false));
  await openTicket();
  fireEvent.click(screen.getByRole('button', { name: 'Mark as resolved' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mark as resolved' }));
  expect(await screen.findByText('Ticket not found')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Mark as resolved' })).toBeInTheDocument();
});

test('a closed ticket offers neither the reply box nor the button', async () => {
  getTickets.mockResolvedValue(jsonRes({ tickets: [{ ...TICKET, status: 'closed' }] }));
  await openTicket();
  expect(screen.getByText(/This ticket is closed/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Mark as resolved' })).not.toBeInTheDocument();
});
