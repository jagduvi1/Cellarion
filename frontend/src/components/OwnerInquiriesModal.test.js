import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api/admin', () => ({
  adminGetOwnerInquiries: vi.fn(),
  adminResolveOwnerInquiry: vi.fn(),
}));

// `t` must keep a stable identity across renders (the WineLowConfidenceModal
// test convention) — components list it in useCallback deps.
vi.mock('react-i18next', () => {
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  return { useTranslation: () => ({ t }) };
});

const { adminGetOwnerInquiries, adminResolveOwnerInquiry } = await import('../api/admin');
const OwnerInquiriesModal = (await import('./OwnerInquiriesModal')).default;

const ROW = {
  _id: 'i1',
  status: 'answered',
  question: 'What does the label say the producer is?',
  askedBy: { _id: 'u9', username: 'somm1' },
  askedVia: 'mcp',
  wineDefinition: { _id: 'w1', name: 'Barolo', producer: 'Pira' },
  recipients: [
    { user: { _id: 'u1', username: 'owner1', email: 'owner1@example.com' }, response: 'Label says E. Pira e Figli', respondedAt: '2026-08-02T00:00:00.000Z' },
    { user: { _id: 'u2', username: 'owner2', email: 'owner2@example.com' }, response: null, respondedAt: null },
  ],
  recipientCount: 2,
  responseCount: 1,
  resolutionNote: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const PAYLOAD = { inquiries: [ROW], total: 1, page: 1, pages: 1, pendingCount: 1, answeredCount: 1 };
const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  adminGetOwnerInquiries.mockResolvedValue(ok(PAYLOAD));
});

const renderModal = () =>
  render(
    <MemoryRouter>
      <OwnerInquiriesModal apiFetch={vi.fn()} onClose={() => {}} onChanged={() => {}} />
    </MemoryRouter>,
  );

test('shows the question, the wine, and each recipient WITH their answer (or the waiting state)', async () => {
  renderModal();
  expect(await screen.findByText('What does the label say the producer is?')).toBeInTheDocument();
  expect(screen.getByText('Pira — Barolo')).toBeInTheDocument();
  // Admin surface: identities show here (and only here).
  expect(screen.getByText('owner1')).toBeInTheDocument();
  expect(screen.getByText(/owner2@example\.com/)).toBeInTheDocument();
  expect(screen.getByText('Label says E. Pira e Figli')).toBeInTheDocument();
  expect(screen.getByText(/admin\.wines\.ownerInquiries\.noAnswerYet/)).toBeInTheDocument();
  // The default fetch asks for the active view.
  expect(adminGetOwnerInquiries.mock.calls[0][1].get('status')).toBe('active');
});

test('resolve interlock: needs a note, disables while POSTing, drops the row and fires onChanged', async () => {
  let release;
  adminResolveOwnerInquiry.mockReturnValue(new Promise((resolve) => {
    release = () => resolve(ok({ status: 'resolved' }));
  }));
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <OwnerInquiriesModal apiFetch={vi.fn()} onClose={() => {}} onChanged={onChanged} />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByText('admin.wines.ownerInquiries.resolve'));

  // Too-short note refuses client-side — no POST fired.
  fireEvent.change(screen.getByPlaceholderText('admin.wines.ownerInquiries.resolvePlaceholder'), { target: { value: 'ok' } });
  fireEvent.click(screen.getByText('admin.wines.ownerInquiries.resolveConfirm'));
  expect(await screen.findByText('admin.wines.ownerInquiries.resolveNoteRequired')).toBeInTheDocument();
  expect(adminResolveOwnerInquiry).not.toHaveBeenCalled();

  fireEvent.change(screen.getByPlaceholderText('admin.wines.ownerInquiries.resolvePlaceholder'), {
    target: { value: 'Producer corrected per the owner answer.' },
  });
  fireEvent.click(screen.getByText('admin.wines.ownerInquiries.resolveConfirm'));

  // In flight: the confirm swaps to the pending label and the row is locked.
  expect(await screen.findByText('admin.wines.ownerInquiries.resolving')).toBeDisabled();
  // An untouched reply field posts as empty — the server then sends the plain
  // thank-you rather than the curator note, which owners must never see.
  expect(adminResolveOwnerInquiry).toHaveBeenCalledWith(expect.any(Function), 'i1', 'Producer corrected per the owner answer.', '');

  release();
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(await screen.findByText('admin.wines.ownerInquiries.emptyActive')).toBeInTheDocument();
});

test('the owner reply is sent as its own field, separate from the curator note', async () => {
  adminResolveOwnerInquiry.mockResolvedValue(ok({ status: 'resolved', notified: 1 }));
  renderModal();

  fireEvent.click(await screen.findByText('admin.wines.ownerInquiries.resolve'));
  fireEvent.change(screen.getByPlaceholderText('admin.wines.ownerInquiries.resolvePlaceholder'), {
    target: { value: 'Curator record: applied, no further action.' },
  });
  fireEvent.change(screen.getByPlaceholderText('admin.wines.ownerInquiries.ownerReplyPlaceholder'), {
    target: { value: 'Thank you — your back label settled it.' },
  });
  fireEvent.click(screen.getByText('admin.wines.ownerInquiries.resolveConfirm'));

  await waitFor(() => expect(adminResolveOwnerInquiry).toHaveBeenCalledWith(
    expect.any(Function),
    'i1',
    'Curator record: applied, no further action.',
    'Thank you — your back label settled it.',
  ));
});

test('no reply field when nobody answered — there is no one to reply to', async () => {
  adminGetOwnerInquiries.mockResolvedValue(ok({
    ...PAYLOAD,
    inquiries: [{ ...ROW, status: 'open', responseCount: 0, recipients: [{ ...ROW.recipients[1] }] }],
  }));
  renderModal();

  fireEvent.click(await screen.findByText('admin.wines.ownerInquiries.resolve'));
  expect(screen.getByPlaceholderText('admin.wines.ownerInquiries.resolvePlaceholder')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('admin.wines.ownerInquiries.ownerReplyPlaceholder')).toBeNull();
});

test('a 409 (someone else resolved it) refetches so the stale row leaves the list', async () => {
  adminResolveOwnerInquiry.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'already resolved' }) });
  renderModal();

  fireEvent.click(await screen.findByText('admin.wines.ownerInquiries.resolve'));
  fireEvent.change(screen.getByPlaceholderText('admin.wines.ownerInquiries.resolvePlaceholder'), {
    target: { value: 'A perfectly valid note.' },
  });
  fireEvent.click(screen.getByText('admin.wines.ownerInquiries.resolveConfirm'));

  expect(await screen.findByText('already resolved')).toBeInTheDocument();
  await waitFor(() => expect(adminGetOwnerInquiries).toHaveBeenCalledTimes(2));
});
