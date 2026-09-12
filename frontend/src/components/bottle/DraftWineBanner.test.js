import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../api/wineDrafts', () => ({
  publishWineDraft: vi.fn(),
  attachWineDraft: vi.fn(),
  updateWineDraft: vi.fn(),
}));
const { authState } = vi.hoisted(() => ({ authState: { apiFetch: vi.fn(), user: { _id: 'me' } } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('react-router-dom', () => ({ Link: ({ children, to }) => <a href={to}>{children}</a> }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      const s = typeof fallback === 'string' ? fallback : key;
      return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
    },
  }),
  Trans: ({ i18nKey }) => <span>{i18nKey}</span>,
}));

const { publishWineDraft, attachWineDraft } = await import('../../api/wineDrafts');
const DraftWineBanner = (await import('./DraftWineBanner')).default;

const WINE = { _id: 'w1', name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', draft: true };
const res = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { _id: 'me' };
});

describe('DraftWineBanner', () => {
  test('a shared-cellar member sees what it is, with no actions', () => {
    render(<DraftWineBanner wine={WINE} wineDraft={{ mine: false, expiresAt: null }} onChanged={() => {}} />);
    expect(screen.getByText('Private draft')).toBeInTheDocument();
    expect(screen.getByText(/private draft of the person who added it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByText('All my drafts')).not.toBeInTheDocument();
  });

  test('the creator sees the deadline, the drafts link, and Edit / Publish; a demo account gets no actions', () => {
    const { unmount } = render(<DraftWineBanner wine={WINE} wineDraft={{ mine: true, expiresAt: '2026-09-19T00:00:00Z' }} onChanged={() => {}} />);
    expect(screen.getByText(/publishes by itself on/)).toBeInTheDocument();
    expect(screen.getByText('All my drafts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    unmount();

    authState.user = { _id: 'me', isDemo: true };
    render(<DraftWineBanner wine={WINE} wineDraft={{ mine: true, expiresAt: null }} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  test('publish → 200 tells the creator and refreshes the bottle', async () => {
    const onChanged = vi.fn();
    publishWineDraft.mockResolvedValue(res({ published: true, promoted: true, pendingCuration: false }));
    render(<DraftWineBanner wine={WINE} wineDraft={{ mine: true }} onChanged={onChanged} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })); });
    expect(publishWineDraft).toHaveBeenCalledWith(authState.apiFetch, 'w1', { confirmCreate: false });
    expect(await screen.findByText('Published to the shared registry.')).toBeInTheDocument();
    // The notice is handed up with the change: the page keeps it after the
    // refetch unmounts this banner (audit 2026-09-12).
    expect(onChanged).toHaveBeenCalledWith('Published to the shared registry.');
  });

  test('publish → 409 similar opens the choice with "create new" still available; confirming re-publishes with confirmCreate', async () => {
    publishWineDraft
      .mockResolvedValueOnce(res({ error: 'similar', code: 'similar', candidates: [{ wine_id: 't1', name: 'Kaefferkopf VV', producer: 'Cave', score: 0.9 }] }, false, 409))
      .mockResolvedValueOnce(res({ published: true, promoted: true }));
    render(<DraftWineBanner wine={WINE} wineDraft={{ mine: true }} onChanged={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })); });
    expect(await screen.findByText('Kaefferkopf VV')).toBeInTheDocument();
    expect(screen.getByText('draftWine.similarIntro')).toBeInTheDocument();
    const createNew = screen.getByRole('button', { name: 'similarWines.createNew' });
    await act(async () => { fireEvent.click(createNew); });
    expect(publishWineDraft).toHaveBeenLastCalledWith(authState.apiFetch, 'w1', { confirmCreate: true });
  });

  test('publish → 409 duplicate offers ONLY attach; picking attaches the bottles and refreshes', async () => {
    const onChanged = vi.fn();
    publishWineDraft.mockResolvedValue(res({ error: 'dup', code: 'duplicate', match: { wine_id: 't1', name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France' } }, false, 409));
    attachWineDraft.mockResolvedValue(res({ attached: true, bottlesMoved: 2, wine: { _id: 't1', name: 'Kaefferkopf' } }));
    render(<DraftWineBanner wine={WINE} wineDraft={{ mine: true }} onChanged={onChanged} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })); });
    expect(await screen.findByText('draftWine.duplicateIntro')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'similarWines.createNew' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Attach my bottles' })); });
    expect(attachWineDraft).toHaveBeenCalledWith(authState.apiFetch, 'w1', 't1');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Your bottles now sit on the registry wine.')).toBeInTheDocument();
  });

  test('publish → 400 (unusable producer) shows the server message', async () => {
    publishWineDraft.mockResolvedValue(res({ error: '"Bordeaux" is a wine region, not a producer', code: 'invalid_identity' }, false, 400));
    render(<DraftWineBanner wine={WINE} wineDraft={{ mine: true }} onChanged={() => {}} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('wine region, not a producer');
  });
});
