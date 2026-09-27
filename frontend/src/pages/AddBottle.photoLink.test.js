/**
 * AddBottle — the photos are linked to the bottle as soon as it exists.
 *
 * A photo is uploaded BEFORE the bottle is saved (the upload runs while the
 * form is filled in), and is linked to the first bottle once the POSTs land.
 * When the server refuses a custom field, the add stops at a notice — and the
 * link used to run only from the notice's Close button. Leaving the page any
 * other way stranded the photos: no bottle, no wine, a row in the admin queue
 * that nobody could act on until the 30-day sweep (audit 2026-09-27 M1).
 *
 * Locked here: the link is made before the notice is shown, and once only.
 *
 * Harness cloned from AddBottle.customFields.test.js; ImageUpload is stubbed
 * to a button that reports one finished upload.
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
vi.mock('../components/ImageUpload', () => ({
  default: ({ onUploadComplete }) => (
    <button type="button" onClick={() => onUploadComplete({ _id: 'img-1' })}>upload-photo</button>
  ),
}));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));

const ROWS = [
  { keyName: 'ABV', keyType: 'decimal', unit: '%', value: '13.5', level: 'wine-vintage' },
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

/** Racks answer empty, the link answers ok, every bottle POST creates the next id. */
const routeApi = (bodyFor = () => ({})) => apiFetchMock.mockImplementation(async (url) => {
  if (url.startsWith('/api/racks?cellar=')) return jsonRes({ racks: [] });
  if (url === '/api/images/link-to-bottle') return jsonRes({ linked: 1 });
  postCount += 1;
  return jsonRes({
    bottle: { _id: `b${postCount}`, wineDefinition: { _id: 'w-new' }, vintage: '2019' },
    priceWarnings: [],
    ...bodyFor(postCount),
  }, true, 201);
});

const linkCalls = () => apiFetchMock.mock.calls
  .filter(([url]) => url === '/api/images/link-to-bottle')
  .map(([, opts]) => JSON.parse(opts.body));

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

/** One uploaded photo, two bottles, a vintage, and the seeded custom field. */
async function uploadAndSubmitWithFields() {
  await reachStepTwo();
  fireEvent.click(screen.getByText('upload-photo'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'),
    { target: { value: '2019' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '2' } });
  fireEvent.click(await screen.findByText('seed-fields'));
  await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });
}

describe('AddBottle — linking the uploaded photos', () => {
  test('a refused custom field: the photos are linked BEFORE the notice, not from its Close button', async () => {
    routeApi((n) => (n === 1
      ? { customFieldErrors: [{ key: 'ABV', error: 'You already use "ABV" as a text key' }] }
      : {}));
    await uploadAndSubmitWithFields();

    await waitFor(() =>
      expect(screen.getByText('addBottle.customFieldsNotSaved')).toBeInTheDocument());
    // The bottles exist and the photo is theirs — already, with the dialog still open.
    expect(linkCalls()).toEqual([{ bottleId: 'b1', imageIds: ['img-1'] }]);
    expect(navigateMock).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByText('common.close')); });

    // Dismissing resumes the flow, and links once only.
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1'));
    expect(linkCalls()).toHaveLength(1);
  });

  test('a clean add links the photos once, on the way to the cellar', async () => {
    routeApi();
    await uploadAndSubmitWithFields();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cellars/cellar1'));
    expect(linkCalls()).toEqual([{ bottleId: 'b1', imageIds: ['img-1'] }]);
  });
});
