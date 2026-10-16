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
// The custom-fields block reads the key vocabulary through apiFetch; these
// tests route apiFetch positionally, so a stub keeps them about the bottles.
vi.mock('../components/bottle/AddBottleCustomFields', () => ({
  default: () => <div />,
  buildPersonalDataPayload: () => [],
}));

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
    // The offer only needs to know racks exist — the light summary, not every bottle.
    expect(apiFetchMock.mock.calls.some(([url]) => url === '/api/racks?cellar=cellar1&summary=1')).toBe(true);

    fireEvent.click(screen.getByTestId('place-now'));
    expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1/racks', { state: { placeQueue: ['b1', 'b2'] } });
  });

  // The cellar page then says what was added, with "Add another bottle"
  // (newcomer walkthrough 2026-10-15).
  // Not opened from the list here (no `cameFrom`): the add page is replaced,
  // so Back never lands on an emptied form — from the place dialog too, once
  // its own Back entry is gone (release audit 2026-10-16).
  const NOTICE = { addedNotice: { name: 'Kaefferkopf 2019', count: 2, history: false, onOrder: false } };
  const ADDED = { replace: true, state: NOTICE };

  test('"Not now" goes to the cellar page, which says what was added', async () => {
    routeApi({ racks: [{ _id: 'r1' }] });
    await submitTwoBottles();
    await waitFor(() => expect(screen.getByText('addBottle.placePrompt.title')).toBeInTheDocument());

    fireEvent.click(screen.getByText('addBottle.placePrompt.notNow'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1', ADDED));
  });

  test('a cellar WITHOUT racks never sees the offer', async () => {
    routeApi({ racks: [] });
    await submitTwoBottles();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1', ADDED));
    expect(screen.queryByText('addBottle.placePrompt.title')).not.toBeInTheDocument();
  });

  test('Cancel leaves without a notice: nothing was added', async () => {
    routeApi({ racks: [] });
    render(<AddBottle />);
    fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
    fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: 'kaefferkopf kaysersberg' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });
    await waitFor(() => expect(screen.getByText('common.cancel')).toBeInTheDocument());
    fireEvent.click(screen.getByText('common.cancel'));
    expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1');
  });
});

// The name is the wine the server filed the bottles under, not what was typed:
// a "did you mean?" pick at commit, or a resolve to an existing wine.
test('the notice names the wine the bottles were saved under', async () => {
  apiFetchMock.mockImplementation(async (url) => {
    if (url.startsWith('/api/racks?cellar=')) return jsonRes({ racks: [] });
    apiFetchMock.__n = (apiFetchMock.__n || 0) + 1;
    return jsonRes({ bottle: { _id: `s${apiFetchMock.__n}`, wineDefinition: { _id: 'w-x', name: 'Kaefferkopf Grand Cru' }, vintage: '2019' }, priceWarnings: [] }, true, 201);
  });
  await submitTwoBottles();
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1', {
    replace: true, state: { addedNotice: { name: 'Kaefferkopf Grand Cru 2019', count: 2, history: false, onOrder: false } },
  }));
});

// Release audit 2026-10-16: opened from the cellar list, a save goes BACK to
// it (a second copy of the list made the first Back dead), and the notice
// waits for it in sessionStorage — router state cannot ride a pop.
describe('back to the list it came from', () => {
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
  };
  beforeEach(() => vi.stubGlobal('sessionStorage', store()));
  afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, ''); });

  test('a save goes back to the cellar list and leaves the notice there', async () => {
    window.history.replaceState({ usr: { cameFrom: '/cellars/cellar1' }, key: 'add', idx: 3 }, '');
    routeApi({ racks: [] });
    await submitTwoBottles();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(-1));
    expect(JSON.parse(sessionStorage.getItem('cellarion.handOver'))).toMatchObject({
      key: 'addedNotice', path: '/cellars/cellar1', value: { name: 'Kaefferkopf 2019', count: 2, history: false, onOrder: false },
    });
  });

  test('Cancel with nothing saved goes back to the list it came from (no second copy of it)', async () => {
    window.history.replaceState({ usr: { cameFrom: '/cellars/cellar1' }, key: 'add', idx: 3 }, '');
    routeApi({ racks: [] });
    render(<AddBottle />);
    fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
    fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: 'kaefferkopf kaysersberg' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });
    fireEvent.click(await screen.findByText('common.cancel'));
    expect(navigateMock).toHaveBeenCalledWith(-1);
    expect(sessionStorage.getItem('cellarion.handOver')).toBeNull();
  });

  test('"Add another" after an add on order starts on order', async () => {
    window.history.replaceState({ usr: { cameFrom: '/cellars/cellar1/on-order', addMode: 'onOrder' }, key: 'add', idx: 3 }, '');
    routeApi({ racks: [] });
    render(<AddBottle />);
    fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
    fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: 'kaefferkopf kaysersberg' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });
    expect(await screen.findByText('addBottle.addOnOrderBtn')).toBeInTheDocument();
  });
});
