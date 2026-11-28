/**
 * AddToWishlist — a wine the library does not have can still be wished for.
 *
 * The twin of AddBottle.notFound.test.js: after a finished search the page
 * offers "Enter the wine yourself", and when the AI cannot place the wine the
 * error offers the same hand-entry form. Without it the wishlist had no way
 * forward once the search and the AI both came back empty.
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

const { searchWines, resolveWine, identifyWineByText } = await import('../api/wines');
const { addToWishlist } = await import('../api/wishlist');
const AddToWishlist = (await import('./AddToWishlist')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

const QUERY = 'Weingut Klein Riesling Steinberg';

const searchInput = () => screen.getByPlaceholderText('addToWishlist.searchPlaceholder');
const fieldAfterLabel = (labelKey) => screen.getByText(labelKey).parentElement.querySelector('input');

async function searchFor(q) {
  fireEvent.change(searchInput(), { target: { value: q } });
  await act(async () => { fireEvent.keyDown(searchInput(), { key: 'Enter' }); });
}

function openTextSearch() {
  render(<AddToWishlist />);
  fireEvent.click(screen.getByText('addToWishlist.noCameraSearch'));
}

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
});

describe('AddToWishlist — "Enter the wine yourself" after a search', () => {
  test('opens the hand-entry form with the typed name', async () => {
    openTextSearch();
    await searchFor(QUERY);

    fireEvent.click(screen.getByText('addBottle.notListedEnterByHand'));

    expect(fieldAfterLabel('addToWishlist.wineName')).toHaveValue(QUERY);
    expect(screen.queryByPlaceholderText('addToWishlist.searchPlaceholder')).not.toBeInTheDocument();
  });

  test('is not offered before a search, nor for text typed after it', async () => {
    openTextSearch();
    expect(screen.queryByText('addBottle.notListedEnterByHand')).not.toBeInTheDocument();

    await searchFor(QUERY);
    expect(screen.getByText('addBottle.notListedEnterByHand')).toBeInTheDocument();

    fireEvent.change(searchInput(), { target: { value: `${QUERY} 2021` } });
    expect(screen.queryByText('addBottle.notListedEnterByHand')).not.toBeInTheDocument();
  });
});

describe('AddToWishlist — when the AI cannot place the wine', () => {
  test('the error offers the hand-entry form, and the typed wine is saved with the item', async () => {
    identifyWineByText.mockResolvedValue(jsonRes({ identified: null, match: null, candidates: [], reason: 'ai_unknown' }));
    resolveWine.mockResolvedValue(jsonRes({ wine: null, candidates: [] }));
    addToWishlist.mockResolvedValue(jsonRes({ item: { wineDefinition: { name: QUERY } } }));

    openTextSearch();
    await searchFor(QUERY);
    await act(async () => { fireEvent.click(screen.getByText('addToWishlist.cantFind')); });

    expect(screen.getByText('addToWishlist.couldNotIdentify')).toBeInTheDocument();
    // The error replaces the after-search link; one way out at a time.
    expect(screen.queryByText('addBottle.notListedEnterByHand')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('addBottle.enterByHand'));
    expect(fieldAfterLabel('addToWishlist.wineName')).toHaveValue(QUERY);
    fireEvent.change(fieldAfterLabel('addToWishlist.country'), { target: { value: 'Germany' } });

    await act(async () => { fireEvent.click(screen.getByText('addToWishlist.addBtn')); });
    expect(resolveWine).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: QUERY, country: 'Germany' }));

    // Step 2: the details form; its submit saves the item with the new wine.
    await act(async () => { fireEvent.click(screen.getByText('addToWishlist.addBtn')); });
    expect(addToWishlist).toHaveBeenCalledTimes(1);
    const body = addToWishlist.mock.calls[0][1];
    expect(body.newWine).toEqual(expect.objectContaining({ name: QUERY, country: 'Germany', producer: '' }));
    expect(body.wineDefinitionId).toBeUndefined();
  });
});
