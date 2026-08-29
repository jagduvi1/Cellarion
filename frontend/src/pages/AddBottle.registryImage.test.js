/**
 * AddBottle — showing what the registry already has.
 *
 * Two related gaps this locks shut.
 *
 * 1. The scan card was the ONLY wine-identification surface in the app that
 *    rendered no registry image and no "already in the registry" signal — a
 *    matched scan and an unmatched one looked identical — even though the
 *    backend already sends the fully populated match. Users re-photographed
 *    wines we could already illustrate, and a WRONG match had nothing visual
 *    to give it away while the bottle was still in the user's hand.
 *
 * 2. Step 2 asked for a bottle photo unconditionally. It still asks — user
 *    uploads are where ~89% of the registry's official images come from, and
 *    most wines have none — but when we already hold one it says so.
 *
 * The camera hook is mocked to a callback CAPTOR, matching the sibling
 * back-label suite: the page's reaction to a scan result is what is under test.
 */

import { render, screen, waitFor, act } from '@testing-library/react';

const { apiFetchMock, navigateMock, scannerRef } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
  scannerRef: { current: {} },
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
  default: (apiFetch, callbacks) => {
    scannerRef.current = callbacks;
    return {
      labelCam: { open: false }, labelScanning: false, labelFacing: 'environment',
      setLabelFacing: vi.fn(), labelVideoRef: { current: null }, labelCanvasRef: { current: null },
      startCamera: vi.fn(), startBackCamera: vi.fn(),
      stopCamera: vi.fn(), capturePhoto: vi.fn(),
    };
  },
}));
vi.mock('../components/ImageUpload', () => ({ default: () => <div data-testid="uploader" /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));

vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { resolveWine, searchWines } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

const EXTRACTED = {
  name: 'Barolo', producer: 'Luigi Pira', country: 'Italy', region: 'Piedmont',
  appellation: 'Barolo', type: 'red', grapes: ['Nebbiolo'], confidence: 0.91,
};

/** A scan that matched a registry wine WE ALREADY HAVE A PICTURE OF. */
const MATCHED_WITH_IMAGE = {
  extracted: EXTRACTED,
  match: {
    wine: {
      _id: 'wine-1', name: 'Barolo', producer: 'Luigi Pira', type: 'red',
      image: '/uploads/barolo.png', imageCredit: 'Photo: a member',
    },
  },
  labelImage: 'data:image/png;base64,AAAA',
  scanImageId: 'front-1',
};

/** Matched, but the registry holds no photo for it — the common case (63%). */
const MATCHED_NO_IMAGE = {
  ...MATCHED_WITH_IMAGE,
  match: { wine: { _id: 'wine-2', name: 'Barolo', producer: 'Luigi Pira', type: 'red', image: null } },
};

/** No registry match at all — a wine we have never seen. */
const UNMATCHED = { ...MATCHED_WITH_IMAGE, match: null };

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  apiFetchMock.mockResolvedValue(jsonRes({ images: [] }));
});

const deliverScan = (data) => act(async () => { scannerRef.current.onScanSuccess(data); });

describe('the scan card shows what the registry already holds', () => {
  test('a matched wine WITH a photo shows it beside the user\'s own shot', async () => {
    render(<AddBottle />);
    await deliverScan(MATCHED_WITH_IMAGE);

    // Both shots are labelled, so it is obvious which is which.
    expect(screen.getByText('addBottle.scanYourPhoto')).toBeInTheDocument();
    expect(screen.getByText('addBottle.scanRegistryPhoto')).toBeInTheDocument();

    // Two images on the card: theirs, and ours.
    const shots = screen.getAllByRole('img');
    expect(shots).toHaveLength(2);
    expect(shots.some(img => img.getAttribute('alt') === 'Barolo')).toBe(true);

    // And the credit rides along with our copy.
    expect(screen.getByText('Photo: a member')).toBeInTheDocument();
  });

  test('a matched wine announces itself as already in the registry', async () => {
    render(<AddBottle />);
    await deliverScan(MATCHED_WITH_IMAGE);

    expect(screen.getByText('addBottle.scanRegistryMatch')).toBeInTheDocument();
  });

  test('an UNMATCHED scan shows neither the badge nor a second photo', async () => {
    render(<AddBottle />);
    await deliverScan(UNMATCHED);

    expect(screen.queryByText('addBottle.scanRegistryMatch')).not.toBeInTheDocument();
    expect(screen.queryByText('addBottle.scanRegistryPhoto')).not.toBeInTheDocument();
    // The user's own label photo is still there, alone and uncaptioned.
    expect(screen.queryByText('addBottle.scanYourPhoto')).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  test('a matched wine with NO photo still says it is known, without an empty slot', async () => {
    render(<AddBottle />);
    await deliverScan(MATCHED_NO_IMAGE);

    expect(screen.getByText('addBottle.scanRegistryMatch')).toBeInTheDocument();
    expect(screen.queryByText('addBottle.scanRegistryPhoto')).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });
});

describe('step 2 tells the user whether a photo is actually needed', () => {
  /** Confirm the scan so the page lands on step 2 with a saved wine. */
  const reachStepTwo = async (images) => {
    resolveWine.mockResolvedValue(jsonRes({
      wine: { _id: 'wine-1', name: 'Barolo', producer: 'Luigi Pira', type: 'red', image: null },
      created: false,
    }));
    apiFetchMock.mockImplementation((url) =>
      Promise.resolve(url.startsWith('/api/images/wine/')
        ? jsonRes({ images })
        : jsonRes({})));

    render(<AddBottle />);
    await deliverScan(MATCHED_WITH_IMAGE);
    await act(async () => { screen.getByText('addBottle.scanConfirmWine').click(); });
  };

  test('when we already hold a photo, the prompt says one is not needed', async () => {
    await reachStepTwo([
      { _id: 'img-1', processedUrl: '/uploads/barolo.png', originalUrl: '/uploads/barolo-o.png', assignedToWine: true },
    ]);

    await waitFor(() => {
      expect(screen.getByText('addBottle.photosExisting')).toBeInTheDocument();
    });
    expect(screen.queryByText('addBottle.photosNone')).not.toBeInTheDocument();
    // Softened, never removed — uploading is still offered.
    expect(screen.getByTestId('uploader')).toBeInTheDocument();
  });

  test('when we hold none, the prompt encourages adding one', async () => {
    await reachStepTwo([]);

    await waitFor(() => {
      expect(screen.getByText('addBottle.photosNone')).toBeInTheDocument();
    });
    expect(screen.queryByText('addBottle.photosExisting')).not.toBeInTheDocument();
    expect(screen.getByTestId('uploader')).toBeInTheDocument();
  });
});
