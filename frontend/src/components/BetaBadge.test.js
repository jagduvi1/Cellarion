import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The strip a feature in early access carries: shown only while the feature
// is in beta, with "Give feedback" (a support ticket about the feature) and
// the testers' forum thread when one is linked. Feedback is not offered to
// demo accounts, which cannot file tickets.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, a, b) => (typeof a === 'string' ? a : key) + (b ? `:${JSON.stringify(b)}` : '') }),
}));
let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
const submitSupportTicket = vi.fn();
vi.mock('../api/support', () => ({ submitSupportTicket: (...a) => submitSupportTicket(...a) }));

const { __setFeatureFlagsForTest } = await import('../utils/featureFlags');
const BetaBadge = (await import('./BetaBadge')).default;

const renderBadge = () => render(<MemoryRouter><BetaBadge feature="vintagePage" note="A new layout." /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  auth = { apiFetch: vi.fn(), user: { id: 'u1', preferences: { earlyAccess: true } } };
  __setFeatureFlagsForTest([{ key: 'vintagePage', state: 'beta', forumPath: '/community/discussions/vintage-page' }]);
});

test('in beta: the pill, the note, Give feedback and the forum thread', () => {
  renderBadge();
  expect(screen.getByText('Beta')).toBeInTheDocument();
  expect(screen.getByText('A new layout.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Give feedback' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Discuss with other testers' })).toHaveAttribute('href', '/community/discussions/vintage-page');
});

test('out for everyone, switched off, or unknown: nothing', () => {
  __setFeatureFlagsForTest([{ key: 'vintagePage', state: 'everyone' }]);
  const { container, unmount } = renderBadge();
  expect(container).toBeEmptyDOMElement();
  unmount();
  __setFeatureFlagsForTest([]);
  expect(renderBadge().container).toBeEmptyDOMElement();
});

test('Give feedback sends a beta ticket naming the feature, and thanks the sender', async () => {
  submitSupportTicket.mockResolvedValue({ ok: true, json: async () => ({ ticket: { _id: 't1' } }) });
  renderBadge();
  fireEvent.click(screen.getByRole('button', { name: 'Give feedback' }));
  const box = await screen.findByRole('textbox');
  const send = screen.getByRole('button', { name: 'Send feedback' });
  expect(send).toBeDisabled();
  fireEvent.change(box, { target: { value: '  The bar at the bottom is great  ' } });
  fireEvent.click(send);
  await waitFor(() => expect(submitSupportTicket).toHaveBeenCalledWith(auth.apiFetch, {
    category: 'beta', feature: 'vintagePage', message: 'The bar at the bottom is great',
  }));
  expect(await screen.findByText(/Your feedback is with the Cellarion team/)).toBeInTheDocument();
});

test('a refused ticket shows the server\'s reason and keeps the text', async () => {
  submitSupportTicket.mockResolvedValue({ ok: false, json: async () => ({ error: 'Too many tickets' }) });
  renderBadge();
  fireEvent.click(screen.getByRole('button', { name: 'Give feedback' }));
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Too many tickets');
  expect(screen.getByRole('textbox')).toHaveValue('Hello');
});

test('a demo account sees the strip but no feedback button', () => {
  auth = { ...auth, user: { ...auth.user, isDemo: true } };
  renderBadge();
  expect(screen.getByText('Beta')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Give feedback' })).toBeNull();
});
