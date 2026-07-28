import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/admin', () => ({
  adminGetLowConfidenceWines: vi.fn(),
  adminMarkProfileReviewed: vi.fn(),
  adminUnmarkProfileReviewed: vi.fn(),
}));

// `t` must keep a stable identity across renders, as react-i18next's real one
// does — components list it in useCallback deps, so a fresh function per render
// would spin those callbacks (and any effect keyed on them) forever.
vi.mock('react-i18next', () => {
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  return { useTranslation: () => ({ t }) };
});

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
    expect(params.get('offset')).toBe('0');
  });
});

test('paging after a review offsets by rows drained, not by a fixed page size', async () => {
  // A full page, so "Next" is reachable and the drain is observable.
  const page1 = Array.from({ length: 50 }, (_, i) => ({ ...ARCANE, _id: `w${i}` }));
  adminGetLowConfidenceWines.mockResolvedValue(
    ok({ wines: page1, total: 120, page: 1, pages: 3, threshold: 0.3, reviewedCount: 0 })
  );
  adminMarkProfileReviewed.mockResolvedValue(ok({ profileReviewedAt: 'now' }));
  renderModal();

  await screen.findAllByText('admin.wines.lowConfidence.reviewBtn');
  expect(adminGetLowConfidenceWines.mock.calls.at(-1)[1].get('offset')).toBe('0');

  // Resolve two rows: they leave the outstanding set, shifting everything up by 2.
  fireEvent.click(screen.getAllByText('admin.wines.lowConfidence.reviewBtn')[0]);
  await waitFor(() => expect(adminMarkProfileReviewed).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getAllByText('admin.wines.lowConfidence.reviewBtn')[0]);
  await waitFor(() => expect(adminMarkProfileReviewed).toHaveBeenCalledTimes(2));

  fireEvent.click(screen.getByText('common.next'));

  // Naive offset would be 50 and skip the two rows that shifted into 48 and 49.
  await waitFor(() =>
    expect(adminGetLowConfidenceWines.mock.calls.at(-1)[1].get('offset')).toBe('48'));
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
