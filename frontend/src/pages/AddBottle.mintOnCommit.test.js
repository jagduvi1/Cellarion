/**
 * AddBottle — mint-at-commit.
 *
 * The registry leak being closed: step 1 used to mint the shared
 * WineDefinition via find-or-create the moment the user confirmed the wine —
 * before any bottle existed — so an abandoned flow left an orphan row forever
 * (31 zero-bottle createdVia:'ui' rows on prod, 2026-08-10). Now step 1 only
 * RESOLVES; a not-yet-registered wine rides along as `pendingNewWine` and is
 * minted by POST /api/bottles with the FIRST bottle of the batch.
 *
 * Locked here:
 *   - reaching step 2 with an unmatched wine performs NO write at all
 *   - an N-bottle submit sends `newWine` on the FIRST POST only; the
 *     remaining bottles reference the id the first create returned —
 *     one wine, N bottles
 *   - the step-1 soft-zone "create a new wine" answer is also write-free:
 *     it only carries the fields (+ confirmCreate) forward to the commit
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

// Key-only so assertions target keys, never copy.
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

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  identifyWineByText.mockResolvedValue(jsonRes({
    identified: SUGGESTION, match: null, candidates: [], reason: null,
  }));
  // The registry does not know this wine — resolve reports noMatch, mints nothing.
  resolveWine.mockResolvedValue(jsonRes({ wine: null, created: false, noMatch: true }));
});

/** Search, ask the AI, accept the (unmatched) suggestion → step 2 as pending. */
async function reachStepTwoPending() {
  render(<AddBottle />);
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'),
    { target: { value: 'kaefferkopf kaysersberg' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });
  await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
}

const bottlesCalls = () =>
  apiFetchMock.mock.calls.filter(([url]) => url === '/api/bottles');

describe('AddBottle — nothing is written before the commit', () => {
  test('reaching step 2 with an unmatched wine performs no POST /api/bottles and no mint', async () => {
    await reachStepTwoPending();

    expect(resolveWine).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).not.toHaveBeenCalled();
    // the pending wine is displayed from the stub
    expect(screen.getByText('Cave de Kaysersberg')).toBeInTheDocument();
  });
});

describe('AddBottle — an N-bottle commit mints ONE wine', () => {
  test('first POST carries newWine; the second references the returned wine id', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonRes({
        bottle: { _id: 'b1', wineDefinition: { _id: 'w-new' }, vintage: '2019' },
        priceWarnings: [],
      }, true, 201))
      .mockResolvedValueOnce(jsonRes({
        bottle: { _id: 'b2', wineDefinition: { _id: 'w-new' }, vintage: '2019' },
        priceWarnings: [],
      }, true, 201));

    await reachStepTwoPending();

    fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'),
      { target: { value: '2019' } });
    // numBottles is the first spinbutton on the details form
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });

    const calls = bottlesCalls();
    expect(calls).toHaveLength(2);

    const first = JSON.parse(calls[0][1].body);
    expect(first.newWine).toMatchObject({
      name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France', source: 'ai',
    });
    expect(first.wineDefinition).toBeUndefined();

    const second = JSON.parse(calls[1][1].body);
    expect(second.wineDefinition).toBe('w-new');
    expect(second.newWine).toBeUndefined();

    // resolve ran exactly once, back in step 1 — the commit never re-resolves
    expect(resolveWine).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1');
  });
});

describe('AddBottle — the step-1 soft zone stays write-free', () => {
  test('"create a new wine" carries the fields (+ confirmCreate) to step 2 without any request', async () => {
    resolveWine.mockResolvedValue(jsonRes({
      candidates: [{
        wine: {
          _id: 'w9', name: 'Kaefferkopf', producer: 'Cave Vinicole',
          type: 'white', country: { name: 'France' }, grapes: [],
        },
        score: 0.9,
      }],
    }));
    apiFetchMock.mockResolvedValue(jsonRes({
      bottle: { _id: 'b1', wineDefinition: { _id: 'w-new' }, vintage: '2019' },
      priceWarnings: [],
    }, true, 201));

    render(<AddBottle />);
    fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
    fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'),
      { target: { value: 'kaefferkopf' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });

    // the "did you mean?" modal is up; choosing "create new" writes NOTHING
    await act(async () => { fireEvent.click(screen.getByText('similarWines.createNew')); });
    await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(resolveWine).toHaveBeenCalledTimes(1);

    // …and the eventual commit carries confirmCreate so the server skips the
    // question it already asked
    fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'),
      { target: { value: '2019' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });

    const calls = bottlesCalls();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body);
    expect(body.newWine).toMatchObject({ name: 'Kaefferkopf', confirmCreate: true });
  });
});
