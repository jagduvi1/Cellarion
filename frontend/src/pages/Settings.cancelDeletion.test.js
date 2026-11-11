import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// An account that is scheduled for deletion shows a notice with "Cancel
// deletion". A cancel that fails must say so: the account is still due to be
// erased, and a button that quietly does nothing reads as "done".

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, dv) => (typeof dv === 'string' ? dv : key), i18n: { language: 'en', resolvedLanguage: 'en' } }),
  Trans: ({ children }) => <span>{children}</span>,
}));

const apiFetch = vi.fn();
const setUser = vi.fn();
const USER = {
  id: 'u1', username: 'anna', email: 'anna@example.com', plan: 'free', preferences: {},
  deletionScheduledFor: '2026-12-01T00:00:00.000Z', deletionRequestedAt: '2026-11-24T00:00:00.000Z',
};
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: USER, apiFetch, setUser, updatePreferences: vi.fn() }) }));
vi.mock('../hooks/useVersion', () => ({ default: () => null }));
vi.mock('../utils/pushNotifications', () => ({
  isPushSupported: () => false, getPushPermissionState: () => 'default', subscribeToPush: vi.fn(), unsubscribeFromPush: vi.fn(),
  getCurrentEndpoint: async () => null, getDeviceStatus: async () => null, sendTestPush: vi.fn(),
}));
// The page's other sections load their own data; none of them is under test.
vi.mock('../components/ApiTokensSection', () => ({ default: () => null }));
vi.mock('../components/LanguagePicker', () => ({ default: () => null }));
vi.mock('../components/AiConnectSection', () => ({ default: () => null }));
vi.mock('../components/SelfHostedBridgeSection', () => ({ default: () => null }));
vi.mock('../components/RegistryConnectionSection', () => ({ default: () => null }));
vi.mock('../components/SetPasswordNotice', () => ({ default: () => null }));
vi.mock('../components/McpActivitySection', () => ({ default: () => null }));
vi.mock('../components/ClimateDevicesSection', () => ({ default: () => null }));
vi.mock('../components/OfflineSettings', () => ({ default: () => null }));
vi.mock('../components/EarlyAccessSettings', () => ({ default: () => null }));

const { default: Settings } = await import('./Settings');

const answer = (status, body) => Promise.resolve({ ok: status < 400, status, headers: { get: () => null }, json: () => Promise.resolve(body) });
const cancelCalls = () => apiFetch.mock.calls.filter(([url]) => url === '/api/users/me/cancel-deletion');

function openSettings(cancelAnswer) {
  apiFetch.mockImplementation((url) => (url === '/api/users/me/cancel-deletion' ? cancelAnswer() : answer(200, {})));
  render(<MemoryRouter><Settings /></MemoryRouter>);
  return screen.getByRole('button', { name: 'Cancel deletion' });
}

beforeEach(() => { vi.clearAllMocks(); });

test('a cancel the server refuses says so and leaves the account scheduled', async () => {
  const button = openSettings(() => answer(500, { error: 'Something went wrong' }));
  fireEvent.click(button);

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(setUser).not.toHaveBeenCalled();
  // the button is usable again for another try
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel deletion' })).not.toBeDisabled());
});

test('a cancel that never reaches the server says so', async () => {
  const button = openSettings(() => Promise.reject(new TypeError('Failed to fetch')));
  fireEvent.click(button);

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(setUser).not.toHaveBeenCalled();
});

test('a cancel that goes through clears the schedule and shows no error; an earlier error is cleared on a new try', async () => {
  let ok = false;
  const button = openSettings(() => (ok ? answer(200, { message: 'cancelled' }) : answer(500, {})));
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toBeInTheDocument();

  ok = true;
  fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' }));
  await waitFor(() => expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ deletionScheduledFor: null, deletionRequestedAt: null })));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(cancelCalls()).toHaveLength(2);
});
