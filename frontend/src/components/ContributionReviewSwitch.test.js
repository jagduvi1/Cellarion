import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The admin's switch for reviewing contributions, above Image Review and Data
// Fields. It must say plainly what each state means, offer the button only to
// whoever may press it (the super admin where one is configured), and update
// the app's own texts at once when it is pressed.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
}));
// One stable apiFetch, as AuthContext provides.
vi.mock('../contexts/AuthContext', () => {
  const apiFetch = () => {};
  return { useAuth: () => ({ apiFetch }) };
});
vi.mock('../api/admin', () => ({ adminGetContributionReview: vi.fn(), adminSaveContributionReview: vi.fn() }));
vi.mock('../utils/contributionReview', () => ({ setContributionReviewed: vi.fn() }));

const { adminGetContributionReview, adminSaveContributionReview } = await import('../api/admin');
const { setContributionReviewed } = await import('../utils/contributionReview');
const ContributionReviewSwitch = (await import('./ContributionReviewSwitch')).default;

const ok = (body) => ({ ok: true, json: async () => body });
const WAITING = { photos: 2, values: 1, fields: 0, corrections: 0 };

beforeEach(() => vi.clearAllMocks());

test('on: says contributions wait here; turning it off saves, says so and updates the app\'s texts', async () => {
  adminGetContributionReview.mockResolvedValue(ok({ enabled: true, canChange: true, waiting: WAITING }));
  adminSaveContributionReview.mockResolvedValue(ok({ enabled: false, updatedAt: '2026-11-04T12:00:00.000Z' }));
  render(<ContributionReviewSwitch />);

  expect(await screen.findByText(/wait here until an admin decides them/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Turn review off'));

  await waitFor(() => expect(adminSaveContributionReview).toHaveBeenCalledWith(expect.any(Function), false));
  expect(await screen.findByText(/go live as soon as a member adds them/)).toBeInTheDocument();
  // What was waiting before is still waiting — the admin is told.
  expect(screen.getByText(/3 items from before are still waiting/)).toBeInTheDocument();
  expect(screen.getByText('Turn review on')).toBeInTheDocument();
  expect(setContributionReviewed).toHaveBeenCalledWith(false);
});

test('an admin who may not change it (a super admin is configured) sees the state without the button', async () => {
  adminGetContributionReview.mockResolvedValue(ok({ enabled: true, canChange: false, waiting: WAITING }));
  render(<ContributionReviewSwitch />);
  expect(await screen.findByText('Only the super admin can change this on this server.')).toBeInTheDocument();
  expect(screen.queryByText('Turn review off')).not.toBeInTheDocument();
});

test('a refused change keeps the state and says why', async () => {
  adminGetContributionReview.mockResolvedValue(ok({ enabled: true, canChange: true, waiting: WAITING }));
  adminSaveContributionReview.mockResolvedValue({ ok: false, json: async () => ({ error: 'Access denied' }) });
  render(<ContributionReviewSwitch />);
  fireEvent.click(await screen.findByText('Turn review off'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
  expect(screen.getByText('Turn review off')).toBeInTheDocument();
  expect(setContributionReviewed).not.toHaveBeenCalled();
});
