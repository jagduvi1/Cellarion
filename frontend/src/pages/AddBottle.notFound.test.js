/**
 * AddBottle when the wine is not in the library.
 *
 * Before: a search with no results rendered nothing at all, a failed search
 * only logged to the console, and when the AI could not place the wine the
 * only way out was a wine request — which leaves the page WITHOUT adding the
 * bottle. Now the empty search says so, and "Enter it yourself" opens the same
 * hand-entry form a misread label uses, seeded with what was typed.
 * Also: the add screen opens the way this device last chose (camera / typing).
 */

import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: vi.fn(), user: { preferences: { currency: 'USD' } } }),
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'cellar1' }),
  useNavigate: () => vi.fn(),
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

const { searchWines, identifyWineByText } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', memoryStorage());
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
});
afterEach(() => vi.unstubAllGlobals());

const QUERY = 'Domaine Inconnu Cuvée Rare';

async function searchFor(q = QUERY) {
  render(<AddBottle />);
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: q } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
}

test('a search that finds nothing says so', async () => {
  await searchFor();
  expect(screen.getByRole('status')).toHaveTextContent('addBottle.noLibraryMatch');
});

test('"Enter the wine yourself" opens the hand-entry form with the typed name', async () => {
  await searchFor();
  fireEvent.click(screen.getByText('addBottle.notListedEnterByHand'));

  expect(screen.getByDisplayValue(QUERY)).toBeInTheDocument();
  expect(screen.getByText('addBottle.scanConfirmWine')).toBeInTheDocument();
});

test('when the AI cannot place the wine, the bottle can still be added by hand', async () => {
  identifyWineByText.mockResolvedValue(jsonRes({ identified: null, match: null, candidates: [] }));
  await searchFor();
  await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });

  expect(screen.getByText('addBottle.aiCouldNotIdentify')).toBeInTheDocument();
  fireEvent.click(screen.getByText('addBottle.enterByHand'));
  expect(screen.getByDisplayValue(QUERY)).toBeInTheDocument();
});

test('a search that fails is said, not just logged', async () => {
  searchWines.mockResolvedValue(jsonRes({ error: 'Bad gateway' }, false, 502));
  await searchFor();

  expect(screen.getByRole('alert')).toHaveTextContent('addBottle.searchFailed');
  expect(screen.queryByText('addBottle.noLibraryMatch')).not.toBeInTheDocument();
});

test('the add screen opens the way this device last chose', () => {
  const first = render(<AddBottle />);
  // Default: the camera card, with the typing link.
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  first.unmount();

  render(<AddBottle />);
  expect(screen.getByPlaceholderText('addBottle.searchPlaceholder')).toBeInTheDocument();
  expect(screen.queryByText('addBottle.searchManuallyInstead')).not.toBeInTheDocument();
});
