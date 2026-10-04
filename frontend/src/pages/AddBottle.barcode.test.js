/**
 * AddBottle — the barcode path.
 *
 * WHY THIS TEST EXISTS:
 * A barcode the camera reads must either take the user straight to the wine
 * members already filed it under (no label photo, no AI) or, when unknown,
 * say so and let the label scan carry on — and in both cases the code must
 * ride the bottle POST, because that is the only way the next scan learns it.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { apiFetchMock, navigateMock, barcodeRef, camState, stopCameraMock, startCameraMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
  barcodeRef: { current: null },
  camState: { open: false },
  stopCameraMock: vi.fn(),
  startCameraMock: vi.fn(),
}));

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
  lookupBarcode: vi.fn(),
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
    startCamera: startCameraMock, startBackCamera: vi.fn(), stopCamera: stopCameraMock, capturePhoto: vi.fn(),
  }),
}));
// The watcher itself is tested in hooks/useBarcodeWatch.test.js; here we only
// need what the page hands it, and to fire its callback.
vi.mock('../hooks/useBarcodeWatch', () => ({
  default: (videoRef, opts) => { barcodeRef.current = opts; },
}));
vi.mock('../components/ImageUpload', () => ({ default: () => <div /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
  Trans: ({ i18nKey }) => <span>{i18nKey}</span>,
}));

const { searchWines, lookupBarcode } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const CODE = '4006381333931';
const WINE = {
  _id: 'wine-1', name: 'Barolo', producer: 'Borgogno', type: 'red', image: null,
  country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [{ name: 'Nebbiolo' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  camState.open = true;
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  apiFetchMock.mockResolvedValue(jsonRes({
    bottle: { _id: 'b1', wineDefinition: { _id: WINE._id }, vintage: '2019' },
    priceWarnings: [],
  }, true, 201));
});

const bottlesCalls = () => apiFetchMock.mock.calls.filter(([url]) => url === '/api/bottles');
const detect = (code) => act(async () => { await barcodeRef.current.onDetect(code); });

it('watches for barcodes only while the label camera is open', () => {
  render(<AddBottle />);
  expect(barcodeRef.current.active).toBe(true);
  camState.open = false;
  render(<AddBottle />);
  expect(barcodeRef.current.active).toBe(false);
});

it('a known barcode goes straight to its wine, and rides the bottle POST', async () => {
  lookupBarcode.mockResolvedValue(jsonRes({ wine: WINE, vintage: '2019', owners: 2, code: CODE }));
  render(<AddBottle />);

  await detect(CODE);

  expect(lookupBarcode).toHaveBeenCalledWith(apiFetchMock, CODE);
  expect(stopCameraMock).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText('addBottle.barcodeFound')).toBeInTheDocument());
  expect(screen.getByText('Barolo')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('addBottle.vintagePlaceholder').value).toBe('2019');

  await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });
  const calls = bottlesCalls();
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0][1].body)).toMatchObject({ wineDefinition: WINE._id, barcode: CODE, vintage: '2019' });
});

it('step 2 asks for the barcode; one scanned there is kept for the bottle, no lookup, no shutter', async () => {
  camState.open = false;
  searchWines.mockResolvedValue(jsonRes({ wines: [WINE] }));
  render(<AddBottle />);

  // Reach step 2 by search — no barcode has been read on this path.
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: 'Barolo' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
  await act(async () => { fireEvent.click(screen.getByText('Barolo').closest('.wine-row')); });
  expect(screen.getByText('addBottle.barcodeHelp')).toBeInTheDocument();

  camState.open = true; // the click opens the camera
  await act(async () => { fireEvent.click(screen.getByText('addBottle.barcodeHelpBtn')); });
  expect(startCameraMock).toHaveBeenCalled();
  expect(screen.getByText('addBottle.barcodeOnlyHint')).toBeInTheDocument();
  expect(screen.queryByLabelText('Scan label')).toBeNull(); // nothing to photograph

  await detect(CODE);
  expect(lookupBarcode).not.toHaveBeenCalled(); // the wine is already the user's choice
  expect(stopCameraMock).toHaveBeenCalled();
  camState.open = false;
  expect(screen.getByText('addBottle.barcodeThanks')).toBeInTheDocument();
  expect(screen.queryByText('addBottle.barcodeHelp')).toBeNull();

  fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'), { target: { value: '2018' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });
  expect(JSON.parse(bottlesCalls()[0][1].body)).toMatchObject({ wineDefinition: WINE._id, barcode: CODE });
});

it('an unknown barcode is noted in the viewfinder and the camera stays open for the label', async () => {
  lookupBarcode.mockResolvedValue(jsonRes({ wine: null, code: CODE }));
  render(<AddBottle />);

  await detect(CODE);

  expect(stopCameraMock).not.toHaveBeenCalled();
  expect(screen.getByText('addBottle.barcodeNoted')).toBeInTheDocument();
});
