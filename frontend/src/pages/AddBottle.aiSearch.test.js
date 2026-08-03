/**
 * AddBottle's wine-selection step — the AI search path.
 *
 * This surface had no test at all, and every way it can break is SILENT: a
 * plain-string country rendered as a blank, an unsaved suggestion carried into
 * step 2 where `selectedWine._id` is undefined and only 400s at final submit,
 * or the AI call quietly returning to fire on every search again. A manual
 * click-through passes all three.
 *
 * The behaviour being locked (PR #884): searching is registry-only and writes
 * nothing; AI is opt-in; an unsaved suggestion is only ever turned into a wine
 * through find-or-create, on an explicit press.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  findOrCreateWine: vi.fn(),
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
// The camera hook owns getUserMedia; keep it inert.
vi.mock('../hooks/useLabelScanner', () => ({
  default: () => ({
    labelCam: { open: false }, labelScanning: false, labelFacing: 'environment',
    setLabelFacing: vi.fn(), labelVideoRef: { current: null }, labelCanvasRef: { current: null },
    startCamera: vi.fn(), stopCamera: vi.fn(), capturePhoto: vi.fn(),
  }),
}));
vi.mock('../components/ImageUpload', () => ({ default: () => <div /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));

// Key-only so assertions target keys, never copy — several of these strings
// carry inline English fallbacks that would otherwise shadow the key.
vi.mock('react-i18next', () => {
  const t = (key) => key;
  // SimilarWinesModal — the soft-zone "did you mean?" prompt — renders <Trans>.
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { searchWines, findOrCreateWine, identifyWineByText } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// An AI suggestion is UNSAVED: plain strings, no _id, no populated refs.
const SUGGESTION = {
  name: 'Les Romains', producer: 'Domaine Vacheron', country: 'France',
  region: 'Loire Valley', appellation: 'Sancerre', type: 'white',
  grapes: ['Sauvignon Blanc'], confidence: 0.7,
};
const REGISTRY_WINE = {
  _id: 'w1', name: 'Les Romains', producer: 'Domaine Vacheron', type: 'white',
  country: { name: 'France' }, region: { name: 'Loire Valley' }, grapes: [{ name: 'Sauvignon Blanc' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  findOrCreateWine.mockResolvedValue(jsonRes({ wine: REGISTRY_WINE, created: true }, true, 201));
});

/** Open the text-search pane and run a search for `q`. */
async function search(q = 'vacheron les romains') {
  render(<AddBottle />);
  fireEvent.click(screen.getByText('addBottle.searchManuallyInstead'));
  fireEvent.change(screen.getByPlaceholderText('addBottle.searchPlaceholder'), { target: { value: q } });
  await act(async () => { fireEvent.click(screen.getByText('addBottle.searchBtn')); });
}

const askAi = async () => {
  await act(async () => { fireEvent.click(screen.getByText('addBottle.cantFindAiTitle')); });
};

describe('AddBottle — searching is registry-only', () => {
  test('pressing Search never calls the AI (the regression that polluted the registry)', async () => {
    await search();

    expect(searchWines).toHaveBeenCalledTimes(1);
    expect(identifyWineByText).not.toHaveBeenCalled();
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('registry results stay visible — they are no longer hidden behind an AI card', async () => {
    searchWines.mockResolvedValue(jsonRes({ wines: [REGISTRY_WINE] }));
    identifyWineByText.mockResolvedValue(jsonRes({
      identified: SUGGESTION, match: null, candidates: [], reason: null,
    }));

    await search();
    await askAi();

    // both the suggestion card and the real registry row are on screen
    expect(screen.getByText('addBottle.aiIdentifiedTitle')).toBeInTheDocument();
    expect(screen.getAllByText('Les Romains').length).toBeGreaterThan(1);
  });
});

describe('AddBottle — an unsaved AI suggestion', () => {
  beforeEach(() => {
    identifyWineByText.mockResolvedValue(jsonRes({
      identified: SUGGESTION, match: null, candidates: [], reason: null,
    }));
  });

  test('renders plain-string country/region/grapes instead of silently blanking them', async () => {
    await search();
    await askAi();

    // Reading .name off these strings would render nothing at all — the exact
    // fields the user is being asked to authorise a registry write for.
    expect(screen.getByText('France')).toBeInTheDocument();
    expect(screen.getByText('• Loire Valley')).toBeInTheDocument();
    expect(screen.getByText('• Sancerre')).toBeInTheDocument();
    expect(screen.getByText('Sauvignon Blanc')).toBeInTheDocument();
  });

  test('says it is not in the registry yet, and offers "add it" rather than "use this"', async () => {
    await search();
    await askAi();

    expect(screen.getByText('addBottle.aiIdentifiedHint')).toBeInTheDocument();
    expect(screen.getByText('addBottle.aiAddAndUse')).toBeInTheDocument();
    expect(screen.queryByText('addBottle.aiUseThisWine')).not.toBeInTheDocument();
  });

  test('accepting routes through find-or-create with source:ai — never straight to step 2', async () => {
    await search();
    await askAi();
    await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });

    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    const body = findOrCreateWine.mock.calls[0][1];
    expect(body).toMatchObject({
      name: 'Les Romains', producer: 'Domaine Vacheron', country: 'France',
      appellation: 'Sancerre', type: 'white', source: 'ai',
    });
    expect(body.grapes).toEqual(['Sauvignon Blanc']);
    // and only THEN does the saved wine carry the flow forward
    await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
  });

  test('a soft-zone response opens the "did you mean" modal instead of creating', async () => {
    findOrCreateWine.mockResolvedValue(jsonRes({
      candidates: [{ wine: { ...REGISTRY_WINE, _id: 'w9' }, score: 0.9 }],
    }));

    await search();
    await askAi();
    await act(async () => { fireEvent.click(screen.getByText('addBottle.aiAddAndUse')); });

    expect(screen.queryByText('addBottle.addBottleBtn')).not.toBeInTheDocument();
  });
});

describe('AddBottle — an AI result already in the registry', () => {
  test('is selected directly, writing nothing', async () => {
    identifyWineByText.mockResolvedValue(jsonRes({
      identified: SUGGESTION, match: { wine: REGISTRY_WINE }, candidates: [], reason: null,
    }));

    await search();
    await askAi();

    expect(screen.getByText('addBottle.aiFoundWine')).toBeInTheDocument();
    expect(screen.getByText('addBottle.aiMatchHint')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByText('addBottle.aiUseThisWine')); });

    expect(findOrCreateWine).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
  });
});
