/**
 * AddBottle — how custom fields ride the bottle POSTs (user ticket 6ab05cca).
 *
 * The risky part is not the inputs, it is the split. A BOTTLE-level field is
 * true of one bottle, so it must ride every POST of a batch. A WINE-level
 * field attaches to the shared wine record, so N copies would be N identical
 * rows on one wine — the backend dedupes, but a batch that sends them at all
 * is asking it to clean up after the form.
 *
 * Locked here:
 *   - wine-level rides the FIRST POST only; bottle-level rides all of them
 *   - a POST with no fields carries no `personalData` key at all
 *   - a field the server refuses holds the add open with a notice naming it,
 *     and dismissing it resumes the normal after-add flow (the bottles exist)
 *
 * Harness cloned from AddBottle.mintOnCommit.test.js. The fields block itself
 * is stubbed to a button that seeds rows — its own behaviour is covered in
 * components/bottle/AddBottleCustomFields.test.js — while the real payload
 * builder runs, because it is half of the contract under test.
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

// The rows the stub seeds: one of each level, which is the case the split
// exists for. The real buildPersonalDataPayload turns them into the payload.
const ROWS = [
  { keyName: 'ABV', keyType: 'decimal', unit: '%', value: '13.5', level: 'wine-vintage' },
  { keyName: 'Cork', keyType: 'text', unit: '', value: 'sound', level: 'bottle' },
];
vi.mock('../components/bottle/AddBottleCustomFields', async () => {
  const actual = await vi.importActual('../components/bottle/AddBottleCustomFields');
  return {
    buildPersonalDataPayload: actual.buildPersonalDataPayload,
    default: ({ onChange }) => (
      <button type="button" onClick={() => onChange(ROWS)}>seed-fields</button>
    ),
  };
});

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

let postCount;

/** Any non-bottle read (racks) answers empty; every POST creates the next id. */
const routeApi = (bodyFor = () => ({})) => apiFetchMock.mockImplementation(async (url) => {
  if (url.startsWith('/api/racks?cellar=')) return jsonRes({ racks: [] });
  postCount += 1;
  return jsonRes({
    bottle: { _id: `b${postCount}`, wineDefinition: { _id: 'w-new' }, vintage: '2019' },
    priceWarnings: [],
    ...bodyFor(postCount),
  }, true, 201);
});

beforeEach(() => {
  vi.clearAllMocks();
  postCount = 0;
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  identifyWineByText.mockResolvedValue(jsonRes({
    identified: SUGGESTION, match: null, candidates: [], reason: null,
  }));
  resolveWine.mockResolvedValue(jsonRes({ wine: null, created: false, noMatch: true }));
});

async function reachStepTwo() {
  render(<AddBottle />);
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'),
    { target: { value: 'kaefferkopf kaysersberg' } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });
  await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
}

/** Two bottles, a vintage, and the seeded custom fields. */
async function submitTwoWithFields() {
  await reachStepTwo();
  fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'),
    { target: { value: '2019' } });
  // numBottles > 1 auto-opens the details panel, where the block lives.
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } });
  fireEvent.click(await screen.findByText('seed-fields'));
  await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });
}

const postBodies = () => apiFetchMock.mock.calls
  .filter(([url, opts]) => url === '/api/bottles' && opts?.method === 'POST')
  .map(([, opts]) => JSON.parse(opts.body));

describe('AddBottle — custom fields on the bottle POSTs', () => {
  test('wine-level rides the first POST only; bottle-level rides every one', async () => {
    routeApi();
    await submitTwoWithFields();

    const [first, second] = postBodies();
    expect(postBodies()).toHaveLength(2);

    expect(first.personalData).toEqual([
      { level: 'wine', vintageScoped: true, value: '13.5', newKey: { name: 'ABV', type: 'decimal', unit: '%' } },
      { level: 'bottle', value: 'sound', newKey: { name: 'Cork', type: 'text' } },
    ]);
    // The wine record is shared by both bottles — sending ABV again would ask
    // the backend to dedupe a row the form should never have posted twice.
    expect(second.personalData).toEqual([
      { level: 'bottle', value: 'sound', newKey: { name: 'Cork', type: 'text' } },
    ]);
  });

  test('no fields means no personalData key on the wire', async () => {
    routeApi();
    await reachStepTwo();
    fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'),
      { target: { value: '2019' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });

    expect(postBodies()[0]).not.toHaveProperty('personalData');
  });

  test('a refused field holds the add open, names itself, and then carries on', async () => {
    routeApi((n) => (n === 1
      ? { customFieldErrors: [{ key: 'ABV', error: 'You already use "ABV" as a text key' }] }
      : {}));
    await submitTwoWithFields();

    // The bottles were created — this is a notice, not a failure.
    await waitFor(() =>
      expect(screen.getByText('addBottle.customFieldsNotSaved')).toBeInTheDocument());
    expect(screen.getByText('ABV: You already use "ABV" as a text key')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByText('common.close')); });

    // Dismissing resumes exactly the flow a clean add would have taken.
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1'));
  });

  test('fields added AFTER a partial failure still reach the wine on the retry', async () => {
    // Bottle 1 lands, bottle 2 fails. The user then adds ABV on the error
    // screen and submits again — and the retry resumes at index 1. Keying the
    // wine-level send off `i === 0` drops ABV for good, silently, while the
    // form still shows it filled in.
    let attempt = 0;
    apiFetchMock.mockImplementation(async (url) => {
      if (url.startsWith('/api/racks?cellar=')) return jsonRes({ racks: [] });
      attempt += 1;
      if (attempt === 2) return jsonRes({ error: 'Rack is full' }, false, 400);
      postCount += 1;
      return jsonRes({
        bottle: { _id: `b${postCount}`, wineDefinition: { _id: 'w-new' }, vintage: '2019' },
        priceWarnings: [],
      }, true, 201);
    });

    await reachStepTwo();
    fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'),
      { target: { value: '2019' } });
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });

    // One bottle in, one to go, and no fields sent yet.
    expect(postBodies()).toHaveLength(2);
    expect(postBodies()[0]).not.toHaveProperty('personalData');

    fireEvent.click(screen.getByText('seed-fields'));
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });

    const retry = postBodies()[2];
    expect(retry.personalData).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: 'wine', vintageScoped: true })])
    );
  });

  test('the same failure on every bottle is reported once, not N times', async () => {
    routeApi(() => ({ customFieldErrors: [{ key: 'Cork', error: 'not a number' }] }));
    await submitTwoWithFields();

    await waitFor(() =>
      expect(screen.getByText('addBottle.customFieldsNotSaved')).toBeInTheDocument());
    expect(screen.getAllByText('Cork: not a number')).toHaveLength(1);
  });
});
