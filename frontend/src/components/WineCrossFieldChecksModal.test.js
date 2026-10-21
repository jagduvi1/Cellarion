import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The cross-field queue shrinks by one row per "Looks fine" in the default
// view, so it pages by explicit offset: rows already resolved are subtracted,
// or "Next" would step over the rows that moved up.

vi.mock('../api/admin', () => ({
  adminGetCrossFieldChecks: vi.fn(),
  adminClearCrossChecks: vi.fn(),
  adminUnclearCrossChecks: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }) => <a href={to}>{children}</a>,
}));

// A stable `t`, as react-i18next's real one is; it returns the key.
vi.mock('react-i18next', () => {
  const t = (key) => key;
  return { useTranslation: () => ({ t }) };
});

const {
  adminGetCrossFieldChecks,
  adminClearCrossChecks,
  adminUnclearCrossChecks,
} = await import('../api/admin');
const WineCrossFieldChecksModal = (await import('./WineCrossFieldChecksModal')).default;

const row = (i) => ({
  _id: `w${i}`,
  name: `Wine ${i}`,
  producer: 'Monbazillac',
  appellation: null,
  region: null,
  hits: [{ check: 'producer-is-appellation.v1', detail: 'Monbazillac' }],
  cleared: [],
});

const PAYLOAD = {
  wines: Array.from({ length: 50 }, (_, i) => row(i)),
  total: 120,
  page: 1,
  pages: 3,
  clearedCount: 0,
  allCheckIds: ['producer-is-appellation.v1', 'region-is-country.v1'],
  checkLabelKeys: { 'producer-is-appellation.v1': 'producerIsAppellation', 'region-is-country.v1': 'regionIsCountry' },
  checkFields: { 'producer-is-appellation.v1': 'producer', 'region-is-country.v1': 'region' },
  ruleCounts: { 'producer-is-appellation.v1': 120, 'region-is-country.v1': 0 },
};

const ok = (body) => ({ ok: true, json: async () => body });
const lastParams = () => adminGetCrossFieldChecks.mock.calls.at(-1)[1];

beforeEach(() => {
  vi.clearAllMocks();
  adminGetCrossFieldChecks.mockResolvedValue(ok(PAYLOAD));
  adminClearCrossChecks.mockResolvedValue(ok({ updated: 1 }));
  adminUnclearCrossChecks.mockResolvedValue(ok({ updated: 1 }));
});

const renderModal = () => render(<WineCrossFieldChecksModal apiFetch={vi.fn()} onClose={() => {}} />);

const clearFirstRow = async (times) => {
  fireEvent.click(screen.getAllByText('admin.wines.crossField.clearBtn')[0]);
  await waitFor(() => expect(adminClearCrossChecks).toHaveBeenCalledTimes(times));
};

test('renders the rows and the first request starts at offset 0', async () => {
  renderModal();
  expect(await screen.findByText('Wine 0')).toBeInTheDocument();
  expect(lastParams().get('offset')).toBe('0');
  expect(lastParams().get('limit')).toBe('50');
});

test('after clearing two rows on a full page, Next asks for offset 48', async () => {
  renderModal();
  await screen.findAllByText('admin.wines.crossField.clearBtn');
  await clearFirstRow(1);
  await clearFirstRow(2);

  fireEvent.click(screen.getByText('common.next'));

  // A page-number offset would be 50 and skip the two rows now at 48 and 49.
  await waitFor(() => expect(lastParams().get('offset')).toBe('48'));
});

test('Undo gives the drained row back', async () => {
  renderModal();
  await screen.findAllByText('admin.wines.crossField.clearBtn');
  await clearFirstRow(1);
  fireEvent.click(await screen.findByText('common.undo'));
  await waitFor(() => expect(adminUnclearCrossChecks).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText('common.undo')).not.toBeInTheDocument());

  fireEvent.click(screen.getByText('common.next'));

  await waitFor(() => expect(lastParams().get('offset')).toBe('50'));
});

test('changing the rule picker starts a fresh count', async () => {
  renderModal();
  await screen.findAllByText('admin.wines.crossField.clearBtn');
  await clearFirstRow(1);
  await clearFirstRow(2);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'producer-is-appellation.v1' } });
  await waitFor(() => expect(lastParams().get('check')).toBe('producer-is-appellation.v1'));
  expect(lastParams().get('offset')).toBe('0');
  await screen.findAllByText('admin.wines.crossField.clearBtn');

  fireEvent.click(screen.getByText('common.next'));

  await waitFor(() => expect(lastParams().get('offset')).toBe('50'));
});

test('in the audit view a clear keeps the row, so the offset is not reduced', async () => {
  renderModal();
  await screen.findAllByText('admin.wines.crossField.clearBtn');
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(lastParams().get('includeCleared')).toBe('1'));
  await screen.findAllByText('admin.wines.crossField.clearBtn');
  await clearFirstRow(1);
  await waitFor(() => expect(adminGetCrossFieldChecks.mock.calls.length).toBeGreaterThanOrEqual(3));

  fireEvent.click(screen.getByText('common.next'));

  await waitFor(() => expect(lastParams().get('offset')).toBe('50'));
});
