/**
 * AddBottle's wine-selection step — the Registry Bridge path (self-hosted).
 *
 * WHY THIS TEST EXISTS:
 * A shared-registry identity is not a saved wine: it has `id`, plain-string
 * geography and no `_id`. Rendering it through the local-row renderer would
 * show blank geography, and selecting it would carry `wineId: undefined`
 * into the commit (see AddBottle.aiSearch.test.js for the same class of
 * silent bug). So registry rows live in their own list, render their strings,
 * and picking one ADOPTS it — one POST that returns a normal local doc —
 * before the normal selection path runs. A failed adoption is told, not
 * swallowed.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
}));
vi.mock('../api/bridge', () => ({
  adoptRegistryWine: vi.fn(),
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
// Key-only so assertions target keys, never copy.
vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { searchWines } = await import('../api/wines');
const { adoptRegistryWine } = await import('../api/bridge');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const RID = 'a'.repeat(24);
const REGISTRY_ROW = {
  id: RID, registryId: RID, source: 'registry', slug: 'torres-salmos', producer: 'Torres', name: 'Salmos', type: 'red',
  appellation: 'Priorat', region: 'Catalonia', country: 'Spain', grapes: ['Cariñena', 'Syrah'], image: null, imageCredit: null,
};
const LOCAL_WINE = {
  _id: 'w1', name: 'Salmos', producer: 'Torres', type: 'red', registryId: RID,
  country: { name: 'Spain' }, region: { name: 'Catalonia' }, grapes: [{ name: 'Cariñena' }, { name: 'Syrah' }],
};

/** Open the text-search pane and run a search (same steps as the AI-search suite). */
async function search(q = 'salmos') {
  render(<AddBottle />);
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: q } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AddBottle — shared-registry results (Registry Bridge)', () => {
  test('registry identities render in their own list with their plain-string geography and a badge', async () => {
    searchWines.mockResolvedValue(jsonRes({ wines: [], registryWines: [REGISTRY_ROW] }));
    await search();
    expect(await screen.findByText('addBottle.registryResults')).toBeInTheDocument();
    expect(screen.getByText('Salmos')).toBeInTheDocument();
    expect(screen.getByText('addBottle.registryBadge')).toBeInTheDocument();
    expect(screen.getByText('Spain')).toBeInTheDocument();
    expect(screen.getByText('• Catalonia')).toBeInTheDocument();
    expect(screen.getByText('Cariñena, Syrah')).toBeInTheDocument();
  });

  test('the hosted instance never shows the block: no registryWines in the answer, no list', async () => {
    searchWines.mockResolvedValue(jsonRes({ wines: [] }));
    await search();
    await waitFor(() => expect(searchWines).toHaveBeenCalled());
    expect(screen.queryByText('addBottle.registryResults')).toBeNull();
  });

  test('picking a registry row adopts it and continues with the LOCAL doc it returns', async () => {
    searchWines.mockResolvedValue(jsonRes({ wines: [], registryWines: [REGISTRY_ROW] }));
    adoptRegistryWine.mockResolvedValue(jsonRes({ wine: LOCAL_WINE, created: true }, true, 201));
    await search();
    await act(async () => { fireEvent.click(await screen.findByText('Salmos')); });
    await waitFor(() => expect(adoptRegistryWine).toHaveBeenCalledWith(expect.anything(), RID));
    // Step 2 shows the selected (local) wine; the registry list is gone.
    expect(await screen.findByText('addBottle.changeWine')).toBeInTheDocument();
    expect(screen.queryByText('addBottle.registryResults')).toBeNull();
  });

  test('a failed adoption is reported and leaves the row selectable', async () => {
    searchWines.mockResolvedValue(jsonRes({ wines: [], registryWines: [REGISTRY_ROW] }));
    adoptRegistryWine.mockResolvedValue(jsonRes({ error: 'unreachable', code: 'unavailable' }, false, 503));
    await search();
    await act(async () => { fireEvent.click(await screen.findByText('Salmos')); });
    expect(await screen.findByText('addBottle.registryAdoptFailed')).toBeInTheDocument();
    expect(screen.getByText('addBottle.registryResults')).toBeInTheDocument();
    expect(screen.queryByText('addBottle.changeWine')).toBeNull();
  });
});
