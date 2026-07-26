import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/admin', () => ({
  adminGetProducerInNameWines: vi.fn(),
  adminStripProducerFromName: vi.fn(),
  adminDeleteWine: vi.fn(),
  adminVerifyWineChecks: vi.fn(),
  adminUnverifyWineChecks: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  // t returns the key so assertions target stable ids, not copy.
  useTranslation: () => ({ t: (key) => key }),
}));

const {
  adminGetProducerInNameWines,
  adminVerifyWineChecks,
  adminUnverifyWineChecks,
} = await import('../api/admin');
const WineProducerInNameModal = (await import('./WineProducerInNameModal')).default;

const OPUS = {
  _id: 'w1',
  producer: 'Opus One',
  name: 'Opus One',
  proposedName: null,
  checks: ['name-equals-producer.v1'],
  verifiedChecks: [],
  verifiedAt: null,
  bottleCount: 0,
  createdAt: '2026-07-26T00:00:00Z',
};

const PAYLOAD = {
  wines: [OPUS],
  total: 1,
  page: 1,
  pages: 1,
  clearedCount: 0,
  scannedCount: 4282,
  checkIds: ['producer-in-name.v1', 'dangling-name-tail.v1', 'name-equals-producer.v1'],
  allCheckIds: [
    'producer-in-name.v1', 'dangling-name-tail.v1',
    'name-equals-producer.v1', 'name-equals-producer-estate.v1',
  ],
  checkLabelKeys: {
    'producer-in-name.v1': 'producerInName',
    'dangling-name-tail.v1': 'danglingTail',
    'name-equals-producer.v1': 'nameEqualsProducer',
    'name-equals-producer-estate.v1': 'nameEqualsProducerEstate',
  },
};

const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  adminGetProducerInNameWines.mockResolvedValue(ok(PAYLOAD));
});

const renderModal = () =>
  render(<WineProducerInNameModal apiFetch={vi.fn()} onClose={() => {}} onChanged={() => {}} />);

test('"Looks fine" sends exactly the row\'s tripped rule ids, drops the row, and offers Undo', async () => {
  adminVerifyWineChecks.mockResolvedValue(ok({ updated: 1, notFlagged: [] }));
  renderModal();

  const verifyBtn = await screen.findByText('admin.wines.producerInName.verifyBtn');
  fireEvent.click(verifyBtn);

  await waitFor(() =>
    expect(adminVerifyWineChecks).toHaveBeenCalledWith(
      expect.any(Function), ['w1'], ['name-equals-producer.v1']
    )
  );
  // The row is gone (empty state), the one-level undo banner is up.
  expect(await screen.findByText('admin.wines.producerInName.empty')).toBeInTheDocument();
  expect(screen.getByText('common.undo')).toBeInTheDocument();
});

test('Undo reverses the clearance with the same wine + rule ids, then refetches', async () => {
  adminVerifyWineChecks.mockResolvedValue(ok({ updated: 1, notFlagged: [] }));
  adminUnverifyWineChecks.mockResolvedValue(ok({ updated: 1 }));
  renderModal();

  fireEvent.click(await screen.findByText('admin.wines.producerInName.verifyBtn'));
  fireEvent.click(await screen.findByText('common.undo'));

  await waitFor(() =>
    expect(adminUnverifyWineChecks).toHaveBeenCalledWith(
      expect.any(Function), ['w1'], ['name-equals-producer.v1']
    )
  );
  // initial load + post-undo refetch
  await waitFor(() => expect(adminGetProducerInNameWines).toHaveBeenCalledTimes(2));
});

test('the rule picker scopes the fetch with ?check=', async () => {
  renderModal();
  await screen.findByText('admin.wines.producerInName.verifyBtn');

  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: 'name-equals-producer-estate.v1' },
  });

  await waitFor(() => {
    const lastParams = adminGetProducerInNameWines.mock.calls.at(-1)[1];
    expect(lastParams.get('check')).toBe('name-equals-producer-estate.v1');
    expect(lastParams.get('page')).toBe('1');
  });
});

test('the audit checkbox requests includeVerified=1 and cleared rows swap to Unverify', async () => {
  renderModal();
  await screen.findByText('admin.wines.producerInName.verifyBtn');

  adminGetProducerInNameWines.mockResolvedValue(ok({
    ...PAYLOAD,
    wines: [{ ...OPUS, verifiedChecks: ['name-equals-producer.v1'] }],
    clearedCount: 1,
  }));
  fireEvent.click(screen.getByRole('checkbox'));

  await waitFor(() => {
    const lastParams = adminGetProducerInNameWines.mock.calls.at(-1)[1];
    expect(lastParams.get('includeVerified')).toBe('1');
  });
  expect(await screen.findByText('admin.wines.producerInName.unverifyBtn')).toBeInTheDocument();
  expect(screen.getByText('admin.wines.producerInName.verifiedBadge')).toBeInTheDocument();
  expect(screen.queryByText('admin.wines.producerInName.verifyBtn')).not.toBeInTheDocument();
});

test('reason pills render from the server\'s label-key map', async () => {
  renderModal();
  // The label appears twice by design: once as a rule-picker option, once as
  // the row's reason pill.
  const matches = await screen.findAllByText('admin.wines.producerInName.reasons.nameEqualsProducer');
  expect(matches.length).toBeGreaterThanOrEqual(2);
});
