import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/admin', () => ({
  adminGetLowConfidenceWines: vi.fn(),
  adminMarkProfileReviewed: vi.fn(),
  adminUnmarkProfileReviewed: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));

const {
  adminGetLowConfidenceWines,
  adminMarkProfileReviewed,
  adminUnmarkProfileReviewed,
} = await import('../api/admin');
const WineLowConfidenceModal = (await import('./WineLowConfidenceModal')).default;

const ARCANE = {
  _id: 'w1',
  name: 'Le Valet d’Épée',
  producer: 'Arcane',
  appellation: null,
  region: null,
  country: 'France',
  confidence: 0.2,
  description: 'a hedge',
  producerSuspect: true,
  producerNote: 'Arcane is a range of Xavier Vignon',
  generatedAt: '2026-07-26T08:57:24Z',
  profileReviewedAt: null,
  bottleCount: 8,
};

const PAYLOAD = { wines: [ARCANE], total: 1, page: 1, pages: 1, threshold: 0.3, reviewedCount: 0 };
const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  adminGetLowConfidenceWines.mockResolvedValue(ok(PAYLOAD));
});

const renderModal = () =>
  render(<WineLowConfidenceModal apiFetch={vi.fn()} onClose={() => {}} onChanged={() => {}} />);

test('shows the model\'s producer doubt as a pill with its note', async () => {
  renderModal();
  expect(await screen.findByText('admin.wines.lowConfidence.producerSuspect')).toBeInTheDocument();
  expect(screen.getByText('Arcane is a range of Xavier Vignon')).toBeInTheDocument();
});

test('"Mark reviewed" calls the API, drops the row, and offers Undo', async () => {
  adminMarkProfileReviewed.mockResolvedValue(ok({ profileReviewedAt: 'now' }));
  renderModal();

  fireEvent.click(await screen.findByText('admin.wines.lowConfidence.reviewBtn'));

  await waitFor(() =>
    expect(adminMarkProfileReviewed).toHaveBeenCalledWith(expect.any(Function), 'w1'));
  expect(await screen.findByText('admin.wines.lowConfidence.empty')).toBeInTheDocument();
  expect(screen.getByText('common.undo')).toBeInTheDocument();
});

test('Undo reverses the review and refetches', async () => {
  adminMarkProfileReviewed.mockResolvedValue(ok({}));
  adminUnmarkProfileReviewed.mockResolvedValue(ok({}));
  renderModal();

  fireEvent.click(await screen.findByText('admin.wines.lowConfidence.reviewBtn'));
  fireEvent.click(await screen.findByText('common.undo'));

  await waitFor(() =>
    expect(adminUnmarkProfileReviewed).toHaveBeenCalledWith(expect.any(Function), 'w1'));
  await waitFor(() => expect(adminGetLowConfidenceWines).toHaveBeenCalledTimes(2));
});

test('the threshold picker refetches with the chosen value', async () => {
  renderModal();
  await screen.findByText('admin.wines.lowConfidence.reviewBtn');

  fireEvent.change(screen.getByRole('combobox'), { target: { value: '0.4' } });

  await waitFor(() => {
    const params = adminGetLowConfidenceWines.mock.calls.at(-1)[1];
    expect(params.get('threshold')).toBe('0.4');
    expect(params.get('page')).toBe('1');
  });
});

test('the audit checkbox requests includeReviewed=1 and reviewed rows swap to Unreview', async () => {
  renderModal();
  await screen.findByText('admin.wines.lowConfidence.reviewBtn');

  adminGetLowConfidenceWines.mockResolvedValue(ok({
    ...PAYLOAD,
    wines: [{ ...ARCANE, profileReviewedAt: '2026-07-27T00:00:00Z' }],
    reviewedCount: 1,
  }));
  fireEvent.click(screen.getByRole('checkbox'));

  await waitFor(() => {
    const params = adminGetLowConfidenceWines.mock.calls.at(-1)[1];
    expect(params.get('includeReviewed')).toBe('1');
  });
  expect(await screen.findByText('admin.wines.lowConfidence.unreviewBtn')).toBeInTheDocument();
  expect(screen.getByText('admin.wines.lowConfidence.reviewedBadge')).toBeInTheDocument();
});
