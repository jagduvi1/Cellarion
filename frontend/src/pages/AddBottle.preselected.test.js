/**
 * AddBottle — a wine handed over in the address (?wine=<id>&vintage=…).
 *
 * WHY THIS TEST EXISTS:
 * "Add to cellar" on a wishlist item and on a wine's page (components/
 * AddToCellarButton) opens this page with the wine already chosen: a member
 * tapped the wishlist's "Bought", expecting the bottle in the cellar, and in
 * the end had to scan it again. The page must land on the bottle's details
 * with that wine — and the wishlist's vintage — and save it like any add.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { apiFetchMock, navigateMock, camState } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
  camState: { open: false },
}));

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
  lookupBarcode: vi.fn(),
  getWine: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: apiFetchMock, user: { preferences: { currency: 'USD' } } }),
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'cellar1' }),
  useNavigate: () => navigateMock,
  Link: ({ children }) => <a href="/">{children}</a>,
}));
vi.mock('../hooks/useLabelScanner', () => ({
  default: () => ({
    labelCam: { open: camState.open, error: null }, labelScanning: false, labelFacing: 'environment',
    setLabelFacing: vi.fn(), labelVideoRef: { current: null }, labelCanvasRef: { current: null },
    startCamera: vi.fn(), startBackCamera: vi.fn(), stopCamera: vi.fn(), capturePhoto: vi.fn(),
  }),
}));
vi.mock('../hooks/useBarcodeWatch', () => ({ default: () => {} }));
vi.mock('../components/ImageUpload', () => ({ default: () => <div /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
  Trans: ({ i18nKey }) => <span>{i18nKey}</span>,
}));

const { getWine, searchWines } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const WINE_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const WINE = {
  _id: WINE_ID, name: 'Barolo', producer: 'Borgogno', type: 'red', image: null,
  country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [{ name: 'Nebbiolo' }],
};
const at = (search) => window.history.replaceState(null, '', `/cellars/cellar1/add-bottle${search}`);

beforeEach(() => {
  vi.clearAllMocks();
  camState.open = false;
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  getWine.mockResolvedValue(jsonRes({ wine: WINE }));
  apiFetchMock.mockResolvedValue(jsonRes({
    bottle: { _id: 'b1', wineDefinition: { _id: WINE_ID }, vintage: '2016' },
    priceWarnings: [],
  }, true, 201));
});
afterEach(() => at(''));

const bottlesCalls = () => apiFetchMock.mock.calls.filter(([url]) => url === '/api/bottles');

it('opens on the bottle details of the handed-over wine, with the vintage, and saves it', async () => {
  at(`?wine=${WINE_ID}&vintage=2016`);
  render(<AddBottle />);

  expect(await screen.findByText('Barolo')).toBeInTheDocument();
  expect(getWine).toHaveBeenCalledWith(apiFetchMock, WINE_ID);
  expect(screen.getByPlaceholderText('addBottle.vintagePlaceholder').value).toBe('2016');

  await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });
  const calls = bottlesCalls();
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0][1].body)).toMatchObject({ cellar: 'cellar1', wineDefinition: WINE_ID, vintage: '2016' });
});

it('without a vintage the field is left for the member', async () => {
  at(`?wine=${WINE_ID}`);
  render(<AddBottle />);
  expect(await screen.findByText('Barolo')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('addBottle.vintagePlaceholder').value).toBe('');
});

it('a malformed id is never sent; a wine that cannot be read leaves the usual start', async () => {
  at('?wine=../../admin');
  const first = render(<AddBottle />);
  await new Promise((r) => setTimeout(r, 20));
  expect(getWine).not.toHaveBeenCalled();
  first.unmount();

  at(`?wine=${WINE_ID}`);
  getWine.mockResolvedValue(jsonRes({ error: 'Wine not found' }, false, 404));
  render(<AddBottle />);
  await waitFor(() => expect(getWine).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('addBottle.addBottleBtn')).toBeNull();
  expect(screen.queryByText('Barolo')).toBeNull();
});

// The handed-over wine is read from the server; on a slow line the member
// may have chosen something else first. A late answer must never replace it.
const lateWine = () => {
  let answer;
  getWine.mockImplementation(() => new Promise((resolve) => { answer = () => resolve(jsonRes({ wine: WINE })); }));
  return () => act(async () => { answer(); });
};

it('a late answer does not replace a wine the member already chose', async () => {
  const OTHER = { ...WINE, _id: 'b1b2c3d4e5f6a1b2c3d4e5f6', name: 'Barbaresco' };
  searchWines.mockResolvedValue(jsonRes({ wines: [OTHER] }));
  at(`?wine=${WINE_ID}&vintage=2016`);
  const answer = lateWine();
  render(<AddBottle />);

  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: 'Barbaresco' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
  await act(async () => { fireEvent.click(screen.getByText('Barbaresco').closest('.wine-row')); });
  fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'), { target: { value: '2019' } });

  await answer();

  expect(screen.getByText('Barbaresco')).toBeInTheDocument();
  expect(screen.queryByText('Barolo')).toBeNull();
  expect(screen.getByPlaceholderText('addBottle.vintagePlaceholder').value).toBe('2019');
  await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });
  expect(JSON.parse(bottlesCalls()[0][1].body)).toMatchObject({ wineDefinition: OTHER._id, vintage: '2019' });
});

it('a late answer does not cut into a label scan that has started', async () => {
  at(`?wine=${WINE_ID}`);
  const answer = lateWine();
  camState.open = true; // the member opened the camera to scan the label
  render(<AddBottle />);

  await answer();

  expect(screen.queryByText('Barolo')).toBeNull();
  expect(screen.queryByText('addBottle.addBottleBtn')).toBeNull();
});
