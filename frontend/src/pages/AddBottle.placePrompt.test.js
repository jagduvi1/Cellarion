/**
 * Issue #1055 — after a successful add into a cellar that has racks, the add
 * flow offers "Place your N bottles now?"; accepting opens the rack view with
 * the new bottle ids as a placing queue, declining goes to the cellar page as
 * before. A cellar without racks never sees the offer. Harness cloned from
 * AddBottle.mintOnCommit.test.js.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { apiFetchMock, navigateMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
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
    labelCam: { open: false }, labelScanning: false, labelFacing: 'environment',
    setLabelFacing: vi.fn(), labelVideoRef: { current: null }, labelCanvasRef: { current: null },
    startCamera: vi.fn(), stopCamera: vi.fn(), capturePhoto: vi.fn(),
  }),
}));
vi.mock('../components/ImageUpload', () => ({ default: () => <div /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));

vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { searchWines, resolveWine, identifyWineByText } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

const SUGGESTION = {
  name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France',
  region: 'Alsace', appellation: '', type: 'white', grapes: ['Gewürztraminer'], confidence: 0.8,
};
const created = (id) => jsonRes({ bottle: { _id: id, wineDefinition: { _id: 'w-new' }, vintage: '2019' }, priceWarnings: [] }, true, 201);

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  identifyWineByText.mockResolvedValue(jsonRes({ identified: SUGGESTION, match: null, candidates: [], reason: null }));
  resolveWine.mockResolvedValue(jsonRes({ wine: null, created: false, noMatch: true }));
});

async function submitTwoBottles() {
  render(<AddBottle />);
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: 'kaefferkopf kaysersberg' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });
  await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'), { target: { value: '2019' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });
}

// apiFetch is called with a URL; route the racks read by its path so the
// order of the two POSTs and the GET does not matter.
const routeApi = ({ racks }) => apiFetchMock.mockImplementation(async (url) => {
  if (url.startsWith('/api/racks?cellar=')) return jsonRes({ racks });
  apiFetchMock.__posts = (apiFetchMock.__posts || 0) + 1;
  return created(`b${apiFetchMock.__posts}`);
});

describe('AddBottle — "Place your bottles now?" (issue #1055)', () => {
  test('a cellar WITH racks gets the offer; "Place now" opens the rack view with the new ids as the queue', async () => {
    routeApi({ racks: [{ _id: 'r1', name: 'Wall', type: 'grid' }] });
    await submitTwoBottles();

    await waitFor(() => expect(screen.getByText('addBottle.placePrompt.title')).toBeInTheDocument());
    expect(navigateMock).not.toHaveBeenCalled(); // skippable, never automatic
    expect(apiFetchMock.mock.calls.some(([url]) => url === '/api/racks?cellar=cellar1')).toBe(true);

    fireEvent.click(screen.getByTestId('place-now'));
    expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1/racks', { state: { placeQueue: ['b1', 'b2'] } });
  });

  test('"Not now" goes to the cellar page exactly as before', async () => {
    routeApi({ racks: [{ _id: 'r1' }] });
    await submitTwoBottles();
    await waitFor(() => expect(screen.getByText('addBottle.placePrompt.title')).toBeInTheDocument());

    fireEvent.click(screen.getByText('addBottle.placePrompt.notNow'));
    expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1');
  });

  test('a cellar WITHOUT racks never sees the offer', async () => {
    routeApi({ racks: [] });
    await submitTwoBottles();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1'));
    expect(screen.queryByText('addBottle.placePrompt.title')).not.toBeInTheDocument();
  });
});
