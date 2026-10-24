/**
 * AddToWishlist — the text search shows the answer to the latest search.
 *
 * Two searches can be in flight at once (Enter on a short query, then on a
 * longer one); whichever lands last must not decide the list. A refused
 * search (a non-ok answer) is a failure, not an empty success: the previous
 * list goes and the page says the search didn't go through, as AddBottle does.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  getWine: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
}));
vi.mock('../api/bridge', () => ({ adoptRegistryWine: vi.fn() }));
vi.mock('../api/wishlist', () => ({ addToWishlist: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: vi.fn(), user: { preferences: { currency: 'USD' } } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ state: null, search: '' }),
  Link: ({ children }) => <a href="/">{children}</a>,
}));
// The camera hook owns getUserMedia; keep it inert.
vi.mock('../hooks/useLabelScanner', () => ({
  default: () => ({
    labelCam: { open: false }, labelScanning: false, labelFacing: 'environment',
    setLabelFacing: vi.fn(), labelVideoRef: { current: null }, labelCanvasRef: { current: null },
    startCamera: vi.fn(), startBackCamera: vi.fn(),
    stopCamera: vi.fn(), capturePhoto: vi.fn(),
  }),
}));

// Key-only so assertions target keys, never copy.
vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { searchWines } = await import('../api/wines');
const AddToWishlist = (await import('./AddToWishlist')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const SHORT_WINE = { _id: 'w-short', name: 'Chablis Short Answer', producer: 'Domaine A', type: 'white' };
const LONG_WINE = { _id: 'w-long', name: 'Chablis Premier Cru Montée de Tonnerre', producer: 'Domaine B', type: 'white' };

const searchInput = () => screen.getByPlaceholderText('addToWishlist.searchPlaceholder');

/** Type `q` into the search box and press Enter (Enter searches even while one is pending). */
async function searchFor(q) {
  fireEvent.change(searchInput(), { target: { value: q } });
  await act(async () => { fireEvent.keyDown(searchInput(), { key: 'Enter' }); });
}

/** Press Enter again without touching the box: a re-search of the same query. */
async function searchAgain() {
  await act(async () => { fireEvent.keyDown(searchInput(), { key: 'Enter' }); });
}

function openTextSearch() {
  render(<AddToWishlist />);
  fireEvent.click(screen.getByText('addToWishlist.noCameraSearch'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AddToWishlist — the latest search wins', () => {
  test('an earlier search that answers last does not replace the later one', async () => {
    const first = deferred();
    const second = deferred();
    searchWines
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    openTextSearch();
    await searchFor('cha');
    await searchFor('chablis premier cru');

    await act(async () => { second.resolve(jsonRes({ wines: [LONG_WINE] })); });
    expect(screen.getByText(LONG_WINE.name)).toBeInTheDocument();

    await act(async () => { first.resolve(jsonRes({ wines: [SHORT_WINE] })); });

    expect(screen.getByText(LONG_WINE.name)).toBeInTheDocument();
    expect(screen.queryByText(SHORT_WINE.name)).not.toBeInTheDocument();
    expect(screen.queryByText('addToWishlist.searching')).not.toBeInTheDocument();
  });

  test('an earlier search that answers first neither paints its wines nor ends the loading state', async () => {
    const first = deferred();
    const second = deferred();
    searchWines
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    openTextSearch();
    await searchFor('cha');
    await searchFor('chablis premier cru');

    await act(async () => { first.resolve(jsonRes({ wines: [SHORT_WINE] })); });

    expect(screen.queryByText(SHORT_WINE.name)).not.toBeInTheDocument();
    expect(screen.getByText('addToWishlist.searching')).toBeInTheDocument();

    await act(async () => { second.resolve(jsonRes({ wines: [LONG_WINE] })); });

    expect(screen.getByText(LONG_WINE.name)).toBeInTheDocument();
    expect(screen.queryByText('addToWishlist.searching')).not.toBeInTheDocument();
  });
});

describe('AddToWishlist — a failed search says so', () => {
  test('a refused search clears the previous list and shows the failure line', async () => {
    searchWines
      .mockResolvedValueOnce(jsonRes({ wines: [LONG_WINE] }))
      .mockResolvedValueOnce(jsonRes({ error: 'Internal server error' }, false, 500));

    openTextSearch();
    await searchFor('chablis premier cru');
    expect(screen.getByText(LONG_WINE.name)).toBeInTheDocument();
    expect(screen.queryByText('addToWishlist.searchFailed')).not.toBeInTheDocument();

    await searchAgain();

    expect(screen.queryByText(LONG_WINE.name)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('addToWishlist.searchFailed');
  });

  test('a network failure shows the failure line, and typing a new query clears it', async () => {
    searchWines.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    openTextSearch();
    await searchFor('chablis');
    expect(screen.getByText('addToWishlist.searchFailed')).toBeInTheDocument();

    fireEvent.change(searchInput(), { target: { value: 'chablis premier' } });

    expect(screen.queryByText('addToWishlist.searchFailed')).not.toBeInTheDocument();
  });

  test('a successful search shows no failure line', async () => {
    searchWines.mockResolvedValueOnce(jsonRes({ wines: [LONG_WINE] }));

    openTextSearch();
    await searchFor('chablis premier cru');

    expect(screen.getByText(LONG_WINE.name)).toBeInTheDocument();
    expect(screen.queryByText('addToWishlist.searchFailed')).not.toBeInTheDocument();
  });
});
