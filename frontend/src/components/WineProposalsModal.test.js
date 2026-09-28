import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api/admin', () => ({
  adminGetWineProposals: vi.fn(),
  adminApproveWineProposal: vi.fn(),
  adminRejectWineProposal: vi.fn(),
  adminBulkApproveWineProposals: vi.fn(),
  adminBulkRejectWineProposals: vi.fn(),
}));

// `t` must keep a stable identity across renders (the WineLowConfidenceModal
// test convention) — the modal lists it in useCallback deps.
vi.mock('react-i18next', () => {
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  return { useTranslation: () => ({ t }) };
});

const { adminGetWineProposals, adminApproveWineProposal, adminBulkApproveWineProposals } = await import('../api/admin');
const WineProposalsModal = (await import('./WineProposalsModal')).default;

// 2026-09-28: approving producer corrections gave wines a spelling the rest of
// their producer did not use. A producer change into such a split is approved
// with a spelling pick — the registry's, the proposed one for all of them, or
// both when they are two producers.
const OTHERS = [{ spelling: 'Chateau Lagrezette', count: 3 }];
const row = (id = 'p1', otherSpellings) => ({
  _id: id, kind: 'field_correction', status: 'pending',
  proposer: { _id: 'u9', username: 'somm1' },
  wineDefinition: { _id: `w-${id}`, name: 'Le Pigeonnier', producer: 'Lagrezette SA' },
  diff: { producer: { current: 'Lagrezette SA', proposed: 'Château Lagrézette', ...(otherSpellings ? { otherSpellings } : {}) } },
  currentSnapshot: { producer: 'Lagrezette SA' },
  reason: 'Estate site.', createdAt: '2026-09-27T00:00:00.000Z',
});
const payload = (rows) => ({ proposals: rows, total: rows.length, page: 1, pages: 1, pendingCount: rows.length });
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const conflict = (body) => ({ ok: false, status: 409, json: async () => body });
const SPLIT_409 = { error: 'The registry already spells this producer …', code: 'producer_spelling_split', proposed: 'Château Lagrézette', spellings: OTHERS };

beforeEach(() => {
  vi.clearAllMocks();
  adminApproveWineProposal.mockResolvedValue(ok({ status: 'approved' }));
});

const renderModal = () =>
  render(
    <MemoryRouter>
      <WineProposalsModal apiFetch={vi.fn()} onClose={() => {}} onChanged={() => {}} />
    </MemoryRouter>,
  );

test('a split from the list names the registry spellings and replaces the plain approve with the picks', async () => {
  adminGetWineProposals.mockResolvedValue(ok(payload([row('p1', OTHERS)])));
  renderModal();
  expect(await screen.findByText(/admin\.wines\.proposals\.otherSpellings:.*spellingCount/)).toBeInTheDocument();
  expect(screen.queryByText('admin.wines.proposals.approve')).toBeNull();

  fireEvent.click(screen.getByText(/approveWithExisting:.*Chateau Lagrezette/));
  await waitFor(() => expect(adminApproveWineProposal).toHaveBeenCalledWith(
    expect.anything(), 'p1', { producerSpelling: 'existing', existingSpelling: 'Chateau Lagrezette' }));
});

test('a rename names the spelling it folds; "keep both" sends its own pick', async () => {
  adminGetWineProposals.mockResolvedValue(ok(payload([row('p1', OTHERS), row('p2', OTHERS)])));
  renderModal();
  // Per spelling, never the whole bucket: two real estates can share one.
  const rename = await screen.findAllByText(/approveRename:.*"from":"Chateau Lagrezette".*"to":"Château Lagrézette"/);
  fireEvent.click(rename[0]);
  await waitFor(() => expect(adminApproveWineProposal).toHaveBeenCalledWith(
    expect.anything(), 'p1', { producerSpelling: 'renameAll', renameSpellings: ['Chateau Lagrezette'] }));

  fireEvent.click(await screen.findByText('admin.wines.proposals.approveKeepBoth'));
  await waitFor(() => expect(adminApproveWineProposal).toHaveBeenCalledWith(expect.anything(), 'p2', { producerSpelling: 'proposed' }));
});

test('every listed spelling gets its own picks — none hidden', async () => {
  const many = ['A', 'B', 'C', 'D'].map((x) => ({ spelling: `Lagrezette ${x}`, count: 1 }));
  adminGetWineProposals.mockResolvedValue(ok(payload([row('p1', many)])));
  renderModal();
  expect(await screen.findByText(/approveWithExisting:.*Lagrezette D/)).toBeInTheDocument();
  expect(screen.getAllByText(/approveRename:/)).toHaveLength(4);
});

test('a split 409 on a plain approve turns that row into the picks instead of refreshing', async () => {
  adminGetWineProposals.mockResolvedValue(ok(payload([row('p1')])));
  adminApproveWineProposal.mockResolvedValueOnce(conflict(SPLIT_409));
  renderModal();
  fireEvent.click(await screen.findByText('admin.wines.proposals.approve'));
  expect(await screen.findByText(/approveRename:.*Château Lagrézette/)).toBeInTheDocument();
  expect(screen.getByText(SPLIT_409.error)).toBeInTheDocument();
  // The row is still pending and still the admin's to decide — no reload.
  expect(adminGetWineProposals).toHaveBeenCalledTimes(1);
});

test('a bulk row that needs a pick keeps the choice on the row', async () => {
  adminGetWineProposals.mockResolvedValue(ok(payload([row('p1')])));
  adminBulkApproveWineProposals.mockResolvedValue(ok({
    results: [{ proposalId: 'p1', ok: false, status: 409, ...SPLIT_409 }], approved: 0, failed: 1,
  }));
  renderModal();
  fireEvent.click(await screen.findByLabelText('admin.wines.proposals.selectRow'));
  fireEvent.click(screen.getByText(/admin\.wines\.proposals\.approveSelected/));
  expect(await screen.findByText('admin.wines.proposals.approveKeepBoth')).toBeInTheDocument();
  expect(screen.queryByText('admin.wines.proposals.approve')).toBeNull();
});

test('a coded 409 (the correction would duplicate a wine) keeps the row and shows why', async () => {
  // Before, every 409 without a spelling code reloaded the page, and the
  // reload cleared the "use a merge proposal instead" message unseen.
  adminGetWineProposals.mockResolvedValue(ok(payload([row('p1')])));
  adminApproveWineProposal.mockResolvedValueOnce(conflict({ error: 'would make the wine identical — use a merge proposal instead', code: 'identical_wine' }));
  renderModal();
  fireEvent.click(await screen.findByText('admin.wines.proposals.approve'));
  expect(await screen.findByText(/use a merge proposal instead/)).toBeInTheDocument();
  expect(adminGetWineProposals).toHaveBeenCalledTimes(1);
});
