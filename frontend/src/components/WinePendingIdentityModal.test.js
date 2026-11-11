import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/somm', () => ({
  sommGetPendingWines: vi.fn(),
  sommFixPendingWine: vi.fn(),
}));

// `t` must keep a stable identity across renders, as react-i18next's real one
// does: the dialog lists it in useCallback deps, so a fresh function per render
// would reload the queue forever.
vi.mock('react-i18next', () => {
  const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  return { useTranslation: () => ({ t }) };
});

const { sommGetPendingWines, sommFixPendingWine } = await import('../api/somm');
const WinePendingIdentityModal = (await import('./WinePendingIdentityModal')).default;

const wine = (n) => ({ _id: `w${n}`, name: `Wine ${n}`, producer: '', bottleCount: 1, createdVia: 'scan' });
const ok = (body) => ({ ok: true, json: async () => body });
const refused = (status, body) => ({ ok: false, status, json: async () => body });

// The queue the server holds; a load is answered with the page it asks for.
let queue;
const PAGE_SIZE = 25;
const answerFromQueue = (apiFetch, params) => {
  const page = Number(params.get('page'));
  const pages = Math.max(1, Math.ceil(queue.length / PAGE_SIZE));
  return Promise.resolve(ok({
    wines: queue.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: queue.length, pages, createdViaOptions: ['scan', 'import'], unavailableTotal: 0,
  }));
};
const pagesAsked = () => sommGetPendingWines.mock.calls.map(([, params]) => Number(params.get('page')));

beforeEach(() => {
  vi.clearAllMocks();
  queue = [wine(1), wine(2)];
  sommGetPendingWines.mockImplementation(answerFromQueue);
});

const renderModal = () => render(<WinePendingIdentityModal apiFetch={vi.fn()} onClose={() => {}} />);

// The server takes the wine out of the queue and says what it did.
const fixSucceeds = (message) => sommFixPendingWine.mockImplementation(async (apiFetch, wineId) => {
  queue = queue.filter((w) => w._id !== wineId);
  return ok({ message });
});

const fixFirstRow = async (producer) => {
  fireEvent.click((await screen.findAllByText('admin.wines.pendingIdentity.fixBtn'))[0]);
  fireEvent.change(screen.getByPlaceholderText('admin.wines.pendingIdentity.producerPlaceholder'), { target: { value: producer } });
  fireEvent.click(screen.getByText('common.save'));
};

test('the confirmation of a fix stays on screen after the list has reloaded', async () => {
  fixSucceeds('Wine 1 is now in the registry.');
  renderModal();
  await fixFirstRow('Example Estate');

  // the list is the reloaded one: the fixed wine is gone, the other is there
  await waitFor(() => expect(screen.queryByText('Wine 1')).not.toBeInTheDocument());
  expect(screen.getByText('Wine 2')).toBeInTheDocument();
  expect(screen.getByText('Wine 1 is now in the registry.')).toBeInTheDocument();
  expect(sommFixPendingWine).toHaveBeenCalledWith(expect.anything(), 'w1', expect.objectContaining({ producer: 'Example Estate' }));
});

test('the confirmation of "no producer on the label" stays after the reload too', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fixSucceeds('Wine 1 left the queue.');
  renderModal();
  fireEvent.click((await screen.findAllByText('admin.wines.pendingIdentity.unavailableBtn'))[0]);

  await waitFor(() => expect(screen.queryByText('Wine 1')).not.toBeInTheDocument());
  expect(screen.getByText('Wine 1 left the queue.')).toBeInTheDocument();
  expect(sommFixPendingWine).toHaveBeenCalledWith(expect.anything(), 'w1', { identityUnavailable: true });
});

test('fixing the only row of a later page steps back one page and asks for it once', async () => {
  queue = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => wine(i + 1));
  fixSucceeds('Wine 26 is now in the registry.');
  renderModal();
  await screen.findByText('Wine 1');
  fireEvent.click(screen.getByText('common.next'));
  await screen.findByText('Wine 26');
  expect(pagesAsked()).toEqual([1, 2]);

  await fixFirstRow('Example Estate');

  await screen.findByText('Wine 1');
  expect(pagesAsked()).toEqual([1, 2, 1]);
  expect(screen.getByText('Wine 26 is now in the registry.')).toBeInTheDocument();
});

test('the confirmation goes when the curator changes the source filter', async () => {
  fixSucceeds('Wine 1 is now in the registry.');
  renderModal();
  await fixFirstRow('Example Estate');
  await screen.findByText('Wine 1 is now in the registry.');

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'import' } });

  await waitFor(() => expect(screen.queryByText('Wine 1 is now in the registry.')).not.toBeInTheDocument());
  expect(sommGetPendingWines.mock.calls.at(-1)[1].get('createdVia')).toBe('import');
});

test('the confirmation goes when the curator pages', async () => {
  queue = Array.from({ length: PAGE_SIZE + 2 }, (_, i) => wine(i + 1));
  fixSucceeds('Wine 1 is now in the registry.');
  renderModal();
  await fixFirstRow('Example Estate');
  await screen.findByText('Wine 1 is now in the registry.');

  fireEvent.click(screen.getByText('common.next'));

  await screen.findByText('Wine 27');
  expect(screen.queryByText('Wine 1 is now in the registry.')).not.toBeInTheDocument();
});

test('a write that is refused does not sit under the confirmation of the one before', async () => {
  fixSucceeds('Wine 1 is now in the registry.');
  renderModal();
  await fixFirstRow('Example Estate');
  await screen.findByText('Wine 1 is now in the registry.');

  sommFixPendingWine.mockResolvedValue(refused(400, { error: 'A producer is required' }));
  await fixFirstRow('   ');

  expect(await screen.findByText('A producer is required')).toBeInTheDocument();
  expect(screen.queryByText('Wine 1 is now in the registry.')).not.toBeInTheDocument();
  // the row is still there to be tried again
  expect(screen.getByPlaceholderText('admin.wines.pendingIdentity.producerPlaceholder')).toBeInTheDocument();
});
