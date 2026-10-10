import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AdminSupportTickets from './AdminSupportTickets';

// On a phone the ticket list sits above the detail panel, so opening a ticket
// used to render the conversation below the fold with no visible change. The
// page now scrolls the panel into view on narrow screens only, once per
// ticket (Johan, 2026-09-07).

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const getTickets = vi.fn();
const respond = vi.fn();
const updateStatus = vi.fn();
vi.mock('../api/admin', () => ({
  adminGetSupportTickets: (...a) => getTickets(...a),
  adminRespondToTicket: (...a) => respond(...a),
  adminUpdateTicketStatus: (...a) => updateStatus(...a),
}));

const jsonRes = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

const TICKET = {
  _id: 't1',
  subject: 'MCP: suggest_wine_correction cannot correct grape varieties',
  message: 'The tool accepts producer and name but not grapes.',
  category: 'feature',
  status: 'open',
  createdAt: '2026-09-06T08:00:00.000Z',
  user: { username: 'reporter', email: 'reporter@example.com' },
  replies: [],
};

let scrollIntoView;
let narrow;

beforeEach(() => {
  vi.clearAllMocks();
  getTickets.mockResolvedValue(jsonRes({ tickets: [TICKET], total: 1 }));
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  narrow = true;
  window.matchMedia = vi.fn((query) => ({
    matches: query.includes('max-width') ? narrow : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  delete Element.prototype.scrollIntoView;
  delete window.matchMedia;
});

async function openFirstTicket() {
  render(<AdminSupportTickets />);
  const item = await screen.findByRole('button', { name: /suggest_wine_correction/ });
  fireEvent.click(item);
  await screen.findByRole('heading', { level: 2, name: TICKET.subject });
}

test('opening a ticket on a narrow screen scrolls the detail panel into view', async () => {
  await openFirstTicket();
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  // The call came from the detail panel, not the list row.
  expect(scrollIntoView.mock.contexts[0]).toHaveClass('admin-support-detail');
});

test('a reply on the open ticket does not scroll again', async () => {
  await openFirstTicket();
  respond.mockResolvedValue(jsonRes({
    ticket: { ...TICKET, status: 'in_progress', replies: [{ author: 'admin', message: 'Working on it now.', createdAt: '2026-09-07T06:00:00.000Z' }] },
  }));
  fireEvent.change(screen.getByPlaceholderText(/write your response/i), { target: { value: 'On it.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send Response' }));
  await screen.findByText('Response sent.');
  expect(screen.getByText('Working on it now.')).toBeInTheDocument();
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

test('a wide screen keeps both columns in view and never scrolls', async () => {
  narrow = false;
  await openFirstTicket();
  expect(scrollIntoView).not.toHaveBeenCalled();
});

test('respects a reduced-motion preference', async () => {
  window.matchMedia = vi.fn((query) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  await openFirstTicket();
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
});

// Beta feedback (sent from a feature's own "Give feedback" button) names the
// feature on its badge, and the queue filters by category — opened from
// SuperAdmin → Feature flags with ?category=beta&feature=<key>, every status.
test('a beta ticket\'s badge names its feature; the category filter reaches the request', async () => {
  getTickets.mockResolvedValue(jsonRes({ tickets: [{ ...TICKET, _id: 't2', category: 'beta', feature: 'vintagePage', featureTitle: 'One page per wine and vintage' }], total: 1 }));
  render(<AdminSupportTickets />);
  expect(await screen.findByText('Beta · One page per wine and vintage')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'beta' } });
  await waitFor(() => expect(getTickets.mock.calls.at(-1)[1]).toMatch(/category=beta/));
});

test('arriving with ?category=beta&feature=… lists that feature\'s feedback in every status', async () => {
  window.history.pushState({}, '', '/admin/support?category=beta&feature=vintagePage');
  try {
    render(<AdminSupportTickets />);
    await waitFor(() => expect(getTickets).toHaveBeenCalled());
    const params = new URLSearchParams(getTickets.mock.calls[0][1]);
    expect(params.get('category')).toBe('beta');
    expect(params.get('feature')).toBe('vintagePage');
    expect(params.get('status')).toBeNull();
    expect(await screen.findByText(/Feature: vintagePage/)).toBeInTheDocument();
  } finally {
    window.history.pushState({}, '', '/');
  }
});
