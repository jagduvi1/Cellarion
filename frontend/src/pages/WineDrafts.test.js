import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api/wineDrafts', () => ({
  listMyWineDrafts: vi.fn(),
  publishWineDrafts: vi.fn(),
  publishWineDraft: vi.fn(),
  attachWineDraft: vi.fn(),
  deleteWineDraft: vi.fn(),
  updateWineDraft: vi.fn(),
}));
const { authState } = vi.hoisted(() => ({ authState: { apiFetch: vi.fn(), user: { _id: 'me' } } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('react-router-dom', () => ({ Link: ({ children, to }) => <a href={to}>{children}</a> }));
vi.mock('react-i18next', () => {
  // One stable t, as the real hook provides.
  const t = (key, fallback, vars) => {
    const s = typeof fallback === 'string' ? fallback : key;
    return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) : s;
  };
  return { useTranslation: () => ({ t }), Trans: ({ i18nKey }) => <span>{i18nKey}</span> };
});

const api = await import('../api/wineDrafts');
const WineDrafts = (await import('./WineDrafts')).default;

const res = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const DRAFTS = [
  { _id: 'd1', name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France', region: 'Alsace', grapes: ['Gewürztraminer'], bottleCount: 2, draftExpiresAt: '2026-09-19T00:00:00Z' },
  { _id: 'd2', name: 'Empty One', producer: '', country: null, region: null, grapes: [], bottleCount: 0, draftExpiresAt: '2026-09-18T00:00:00Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { _id: 'me' };
  api.listMyWineDrafts.mockResolvedValue(res({ drafts: DRAFTS }));
});

describe('WineDrafts page', () => {
  test('lists my drafts with bottle counts; delete is offered only for an empty draft', async () => {
    render(<WineDrafts />);
    expect(await screen.findByText('Cave de Kaysersberg — Kaefferkopf')).toBeInTheDocument();
    expect(screen.getByText(/2 bottle\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/publishes by itself on/)).toBeInTheDocument();
    expect(screen.getByText(/expires /)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  test('"Publish selected" sends the selected ids in one batch and renders each row\'s outcome', async () => {
    api.publishWineDrafts.mockResolvedValue(res({ results: [
      { id: 'd1', status: 'published' },
      { id: 'd2', status: 'invalid_identity', error: 'The draft needs a wine name' },
    ] }));
    render(<WineDrafts />);
    await screen.findByText('Cave de Kaysersberg — Kaefferkopf');
    const publishSelected = screen.getByRole('button', { name: /Publish selected \(0\)/ });
    expect(publishSelected).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Select Kaefferkopf'));
    fireEvent.click(screen.getByLabelText('Select Empty One'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Publish selected \(2\)/ })); });
    expect(api.publishWineDrafts).toHaveBeenCalledWith(authState.apiFetch, ['d1', 'd2']);
    expect(await screen.findByText('Published')).toBeInTheDocument();
    expect(screen.getByText('The draft needs a wine name')).toBeInTheDocument();
  });

  test('a row publish that meets an exact registry match opens attach-only; picking attaches', async () => {
    api.publishWineDraft.mockResolvedValue(res({ code: 'duplicate', error: 'dup', match: { wine_id: 't1', name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' } }, false, 409));
    api.attachWineDraft.mockResolvedValue(res({ attached: true, bottlesMoved: 2, wine: { _id: 't1', name: 'Kaefferkopf' } }));
    render(<WineDrafts />);
    await screen.findByText('Cave de Kaysersberg — Kaefferkopf');
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Publish' })[0]); });
    expect(await screen.findByText('draftWine.duplicateIntro')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'similarWines.createNew' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Attach my bottles' })); });
    expect(api.attachWineDraft).toHaveBeenCalledWith(authState.apiFetch, 'd1', 't1');
    expect(await screen.findByText('Bottles attached to Kaefferkopf')).toBeInTheDocument();
  });

  test('the empty state and the demo account (no actions)', async () => {
    api.listMyWineDrafts.mockResolvedValue(res({ drafts: [] }));
    const { unmount } = render(<WineDrafts />);
    expect(await screen.findByText(/No drafts/)).toBeInTheDocument();
    unmount();

    authState.user = { _id: 'me', isDemo: true };
    api.listMyWineDrafts.mockResolvedValue(res({ drafts: DRAFTS }));
    render(<WineDrafts />);
    await screen.findByText('Cave de Kaysersberg — Kaefferkopf');
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });
});
