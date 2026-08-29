/**
 * AddBottle — a scanned bottle is filed as the label reads, issue #1134.
 *
 * The bug: confirming a scan sent the MATCHED registry row's name, producer
 * and appellation to the resolver instead of what the label said, whenever the
 * scan matcher returned anything at all — and it returns from 0.75. The card
 * kept rendering `extracted.name`, so the swap was invisible: the reporter's
 * Schiffmann-Junk Spätlese Alte Reben, Auslese and Spätlese Feinherb all
 * committed to the Feinherb row and every screen along the way looked right.
 *
 * A producer's range is exactly where this bites, because producer (45% of the
 * composite) and appellation (10%) are identical across it, so the siblings
 * score 0.83–0.90 against each other on the name axis alone.
 *
 * Locked here: the scanned identity is what gets resolved; the matched row is
 * shown BY NAME and only ever offered as a candidate the user picks.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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
vi.mock('../components/ImageUpload', () => ({ default: () => <div /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));

// Unlike the sibling suites this one INTERPOLATES: the whole point of the
// badge change is the values it carries, so a key-only mock would assert
// nothing about the fix.
vi.mock('react-i18next', () => {
  const render = (key, vars) => (vars && Object.keys(vars).length)
    ? `${key} ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(' ')}`
    : key;
  return {
    useTranslation: () => ({ t: render }),
    Trans: ({ i18nKey }) => <span>{i18nKey}</span>,
  };
});

const { searchWines, resolveWine } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

const PRODUCER = 'Weingut Schiffmann-Junk';
const APPELLATION = 'Brauneberger Juffer-Sonnenuhr';
const V = 'Brauneberger Juffer-Sonnenuhr Riesling ';

/** What the camera read off the bottle in the reporter's hand. */
const SCANNED = {
  name: V + 'Spätlese Alte Reben',
  producer: PRODUCER,
  country: 'Germany',
  region: 'Mosel',
  appellation: APPELLATION,
  classification: '',
  type: 'white',
  grapes: ['Riesling'],
  vintage: '2022',
  confidence: 0.93,
};

/** The only Schiffmann row the registry held — a DIFFERENT wine. */
const NEIGHBOUR = {
  _id: 'wine-feinherb',
  name: V + 'Spätlese Feinherb',
  producer: PRODUCER,
  appellation: APPELLATION,
  type: 'white',
  image: null,
  country: { name: 'Germany' },
  region: { name: 'Mosel' },
  grapes: [{ name: 'Riesling' }],
};

const SCAN_RESULT = {
  extracted: SCANNED,
  match: { wine: NEIGHBOUR, confidence: 0.87 },
  labelImage: 'data:image/png;base64,AAAA',
  scanImageId: 'front-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  apiFetchMock.mockResolvedValue(jsonRes({ images: [] }));
});

const deliverScan = (data) => act(async () => { scannerRef.current.onScanSuccess(data); });

const confirmScan = async () => {
  fireEvent.click(screen.getByText('addBottle.scanConfirmWine'));
  await waitFor(() => expect(resolveWine).toHaveBeenCalled());
};

describe('the scanned identity is what gets resolved', () => {
  test('confirming a MATCHED scan sends the label\'s wine, not the matched row', async () => {
    // The resolver answers as it would for this pair: 0.8749 is inside the
    // 0.85–0.95 soft zone, so it asks rather than links.
    resolveWine.mockResolvedValue(jsonRes({
      wine: null,
      candidates: [{ wine: NEIGHBOUR, score: 0.87 }],
    }));

    render(<AddBottle />);
    await deliverScan(SCAN_RESULT);
    await confirmScan();

    const sent = resolveWine.mock.calls[0][1];
    expect(sent.name).toBe(V + 'Spätlese Alte Reben');
    expect(sent.name).not.toBe(NEIGHBOUR.name);
    expect(sent.producer).toBe(PRODUCER);
    expect(sent.appellation).toBe(APPELLATION);
    // The classification the scan read is carried too — the old matched
    // branch dropped the field entirely.
    expect(sent).toHaveProperty('classification');
  });

  test('the soft zone asks instead of filing it silently', async () => {
    resolveWine.mockResolvedValue(jsonRes({
      wine: null,
      candidates: [{ wine: NEIGHBOUR, score: 0.87 }],
    }));

    render(<AddBottle />);
    await deliverScan(SCAN_RESULT);
    await confirmScan();

    // The "did you mean?" dialog, naming the wine it would attach to.
    expect(await screen.findByText('similarWines.createNew')).toBeInTheDocument();
    expect(screen.getByText(NEIGHBOUR.name)).toBeInTheDocument();
    // Nothing was chosen for the user: no bottle-details step, and the scan
    // card is still underneath, so cancelling lands back on it.
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByText('addBottle.scanConfirmWine')).toBeInTheDocument();
  });

  test('an unmatched resolve still offers the scan\'s own match rather than duplicating', async () => {
    // The scan matcher looks from 0.75, the resolver's soft zone from 0.85.
    // A hit in that gap must become a question, not a second registry row.
    resolveWine.mockResolvedValue(jsonRes({ wine: null, created: false, noMatch: true }));

    render(<AddBottle />);
    await deliverScan({ ...SCAN_RESULT, match: { wine: NEIGHBOUR, confidence: 0.78 } });
    await confirmScan();

    expect(await screen.findByText('similarWines.createNew')).toBeInTheDocument();
    expect(screen.getByText(NEIGHBOUR.name)).toBeInTheDocument();
  });

  test('with no scan match at all, an unmatched resolve goes straight on', async () => {
    resolveWine.mockResolvedValue(jsonRes({ wine: null, created: false, noMatch: true }));

    render(<AddBottle />);
    await deliverScan({ ...SCAN_RESULT, match: null });
    await confirmScan();

    // No dialog — step 2, with the wine riding along to be minted on commit.
    await waitFor(() => expect(screen.queryByText('addBottle.scanConfirmWine')).not.toBeInTheDocument());
    expect(screen.queryByText('similarWines.createNew')).not.toBeInTheDocument();
  });

  test('a confident resolve still links, and carries the vintage', async () => {
    resolveWine.mockResolvedValue(jsonRes({ wine: NEIGHBOUR, created: false }));

    render(<AddBottle />);
    await deliverScan(SCAN_RESULT);
    await confirmScan();

    await waitFor(() => expect(screen.queryByText('similarWines.createNew')).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('2022')).toBeInTheDocument();
  });
});

describe('the match is visible on the card', () => {
  test('the badge NAMES the matched wine and states the score', async () => {
    render(<AddBottle />);
    await deliverScan(SCAN_RESULT);

    const badge = screen.getByText(/addBottle\.scanRegistryMatch/);
    expect(badge.textContent).toContain(NEIGHBOUR.name);
    expect(badge.textContent).toContain('87');
  });

  test('the card still shows what the LABEL said, not the matched row', async () => {
    render(<AddBottle />);
    await deliverScan(SCAN_RESULT);

    expect(screen.getByRole('heading', { name: V + 'Spätlese Alte Reben' })).toBeInTheDocument();
  });
});
