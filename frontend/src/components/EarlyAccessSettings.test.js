import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Settings → Early access: the one switch for every feature in beta, the
// list of what is in beta now (shown whether the switch is on or not), what
// was released lately, and "Give feedback" for those trying it.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, a, b) => (typeof a === 'string' ? a : key) + (b ? `:${JSON.stringify(b)}` : (a && typeof a === 'object' ? `:${JSON.stringify(a)}` : '')),
    i18n: { language: 'en-GB' },
  }),
}));
let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('./BetaFeedbackModal', () => ({ default: ({ feature }) => <div data-testid="feedback">{feature}</div> }));

const { __setFeatureFlagsForTest } = await import('../utils/featureFlags');
const EarlyAccessSettings = (await import('./EarlyAccessSettings')).default;

const renderIt = () => render(<MemoryRouter><EarlyAccessSettings /></MemoryRouter>);
const updatePreferences = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  updatePreferences.mockResolvedValue({ success: true });
  auth = { user: { id: 'u1', preferences: { earlyAccess: false } }, updatePreferences };
  __setFeatureFlagsForTest([
    { key: 'vintagePage', state: 'beta', betaAt: '2026-10-10T08:00:00.000Z', releasedAt: null, forumPath: '/community/discussions/vintage-page' },
  ]);
});

test('the list shows what is in beta even with the switch off; feedback only once you try it', () => {
  renderIt();
  const toggle = screen.getByRole('checkbox');
  expect(toggle).not.toBeChecked();
  expect(screen.getByText('One page per wine and vintage')).toBeInTheDocument();
  expect(screen.getByText(/In your cellar list: tap any wine\./)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Discuss with other testers' })).toHaveAttribute('href', '/community/discussions/vintage-page');
  expect(screen.queryByRole('button', { name: 'Give feedback' })).toBeNull();
});

test('the switch saves earlyAccess and reports a failure', async () => {
  renderIt();
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(updatePreferences).toHaveBeenCalledWith({ earlyAccess: true }));

  updatePreferences.mockResolvedValue({ success: false, error: 'Network down' });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
});

test('with early access on, Give feedback opens the form for that feature', () => {
  auth = { ...auth, user: { ...auth.user, preferences: { earlyAccess: true } } };
  renderIt();
  expect(screen.getByRole('checkbox')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Give feedback' }));
  return screen.findByTestId('feedback').then((el) => expect(el).toHaveTextContent('vintagePage'));
});

test('nothing in beta says so; a feature released lately is listed, an old release is not', () => {
  const recent = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const old = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
  __setFeatureFlagsForTest([
    { key: 'vintagePage', state: 'everyone', betaAt: null, releasedAt: recent, forumPath: null },
    { key: 'ancient', state: 'everyone', betaAt: null, releasedAt: old, forumPath: null },
  ]);
  renderIt();
  expect(screen.getByText('Nothing is in beta right now.')).toBeInTheDocument();
  expect(screen.getByText('Recently released')).toBeInTheDocument();
  expect(screen.getByText('One page per wine and vintage')).toBeInTheDocument();
  expect(screen.queryByText('ancient')).toBeNull();
});
