/**
 * AddBottle — the back-label rescue.
 *
 * The invariant this locks is the one that is easy to break silently: the
 * rescue is OPTIONAL. It appears only after a front scan that read half a
 * label or none of it, "Skip" dismisses it, and taking it never overwrites
 * something the user typed while the scan was in flight.
 *
 * And the payload: both scan ids plus the recorded front/back disagreement have
 * to reach POST /api/bottles inside `newWine`, because that commit is where the
 * pendingIdentity wine is minted and the photos become the only thing a curator
 * will have to work from.
 *
 * The camera hook is mocked to a callback CAPTOR rather than an inert stub —
 * getUserMedia does not exist here, but the page's reaction to a scan result is
 * exactly what is under test.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { apiFetchMock, navigateMock, scannerRef, startBackCameraMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  navigateMock: vi.fn(),
  // Filled by the mocked hook on every render, so a test can fire the
  // callbacks the real hook would fire after a capture.
  scannerRef: { current: {} },
  startBackCameraMock: vi.fn(),
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
      startCamera: vi.fn(), startBackCamera: startBackCameraMock,
      stopCamera: vi.fn(), capturePhoto: vi.fn(),
    };
  },
}));
vi.mock('../components/ImageUpload', () => ({ default: () => <div /> }));
vi.mock('../components/RatingInput', () => ({ default: () => <div /> }));

vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { searchWines, resolveWine } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

/** A front scan that read a name but no producer. */
const PARTIAL = {
  extracted: {
    name: 'Kaefferkopf', producer: '', country: '', region: '', appellation: '',
    type: 'white', grapes: [], partial: true,
  },
  match: null,
  labelImage: null,
  scanImageId: 'front-1',
};

/** The back label supplied the producer and the country. */
const BACK_RESULT = {
  merged: {
    name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France',
    region: 'Alsace', appellation: '', type: 'white', grapes: ['Riesling'],
  },
  conflicts: [],
  filled: ['producer', 'country', 'region', 'grapes'],
  match: null,
  backScanImageId: 'back-1',
  frontScanImageId: 'front-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
  resolveWine.mockResolvedValue(jsonRes({ wine: null, created: false, noMatch: true }));
});

/** Deliver a front-scan outcome the way the camera hook would. */
const deliverScan = (data) => act(async () => { scannerRef.current.onScanSuccess(data); });
const deliverScanError = (msg, body) => act(async () => { scannerRef.current.onScanError(msg, body); });
const deliverBack = (data) => act(async () => { scannerRef.current.onBackScanSuccess(data); });

const bottlesCalls = () => apiFetchMock.mock.calls.filter(([url]) => url === '/api/bottles');

describe('the offer appears only when the front label came back incomplete', () => {
  test('a PARTIAL front scan offers the back label', async () => {
    render(<AddBottle />);
    await deliverScan(PARTIAL);

    expect(screen.getByText('addBottle.backScanPrompt')).toBeInTheDocument();
    expect(screen.getByText('addBottle.backScanCta')).toBeInTheDocument();
    // …and what WAS read is already on screen: the rescue never replaces the
    // prefill, it adds to it.
    expect(screen.getByText('Kaefferkopf')).toBeInTheDocument();
  });

  test('a COMPLETE front scan offers nothing — nothing about the flow changes', async () => {
    render(<AddBottle />);
    await deliverScan({
      ...PARTIAL,
      extracted: { ...PARTIAL.extracted, producer: 'Cave de Kaysersberg', partial: undefined },
    });

    expect(screen.queryByText('addBottle.backScanPrompt')).not.toBeInTheDocument();
  });

  test('an unreadable label (422) keeps its photo id and offers the back label', async () => {
    render(<AddBottle />);
    await deliverScanError('Could not read label', { scanImageId: 'front-1' });

    expect(screen.getByText('addBottle.backScanPrompt')).toBeInTheDocument();
  });

  test('a scan failure with no stored photo offers nothing to rescue', async () => {
    render(<AddBottle />);
    await deliverScanError('Scan failed. Please try again.', null);

    expect(screen.queryByText('addBottle.backScanPrompt')).not.toBeInTheDocument();
  });

  test('Skip dismisses it and never blocks anything', async () => {
    render(<AddBottle />);
    await deliverScan(PARTIAL);

    fireEvent.click(screen.getByText('addBottle.backScanSkip'));

    expect(screen.queryByText('addBottle.backScanPrompt')).not.toBeInTheDocument();
    // The ordinary confirm path is still right there.
    expect(screen.getByText('addBottle.scanConfirmWine')).toBeInTheDocument();
  });

  test('taking it opens the camera with the front context the server needs', async () => {
    render(<AddBottle />);
    await deliverScan(PARTIAL);

    fireEvent.click(screen.getByText('addBottle.backScanCta'));

    expect(startBackCameraMock).toHaveBeenCalledWith({
      frontExtracted: PARTIAL.extracted,
      frontScanImageId: 'front-1',
    });
  });
});

describe('the merged result never overwrites the user', () => {
  test('a field the user typed survives the back scan; a blank one is filled', async () => {
    render(<AddBottle />);
    await deliverScan(PARTIAL);

    // The user opens the editable form and types their own producer while the
    // back scan is (notionally) in flight.
    fireEvent.click(screen.getByText('addBottle.scanNotRight'));
    fireEvent.change(screen.getByPlaceholderText('addBottle.scanProducerOptionalPlaceholder'), { target: { value: 'Typed Producer' } });

    await deliverBack(BACK_RESULT);

    // Their value stood…
    expect(screen.getByDisplayValue('Typed Producer')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Cave de Kaysersberg')).not.toBeInTheDocument();
    // …and the blank country was filled from the back label.
    expect(screen.getByDisplayValue('France')).toBeInTheDocument();
  });

  test('a disagreement is reported as a note, not as an error or a prompt', async () => {
    render(<AddBottle />);
    await deliverScan(PARTIAL);
    await deliverBack({
      ...BACK_RESULT,
      conflicts: [{ field: 'producer', front: 'Cave', back: 'Wolfberger' }],
    });

    expect(screen.getByText('addBottle.backScanConflicts')).toBeInTheDocument();
    // The offer is gone — it has been taken.
    expect(screen.queryByText('addBottle.backScanPrompt')).not.toBeInTheDocument();
  });
});

describe('both scan ids and the disagreement ride the commit', () => {
  test('POST /api/bottles carries scanImageId, scanImageBackId and scanConflicts inside newWine', async () => {
    apiFetchMock.mockResolvedValue(jsonRes({
      bottle: { _id: 'b1', wineDefinition: { _id: 'w-new' }, vintage: '2019' },
      priceWarnings: [],
    }, true, 201));

    render(<AddBottle />);
    await deliverScan(PARTIAL);
    await deliverBack({
      ...BACK_RESULT,
      conflicts: [{ field: 'producer', front: 'Cave', back: 'Wolfberger' }],
    });

    // Confirm the (now merged) wine and commit the bottle.
    await act(async () => { fireEvent.click(screen.getByText('addBottle.scanConfirmWine')); });
    await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'), { target: { value: '2019' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });

    const calls = bottlesCalls();
    expect(calls).toHaveLength(1);
    const { newWine } = JSON.parse(calls[0][1].body);
    expect(newWine).toMatchObject({
      name: 'Kaefferkopf',
      producer: 'Cave de Kaysersberg',
      scanImageId: 'front-1',
      scanImageBackId: 'back-1',
      scanConflicts: [{ field: 'producer', front: 'Cave', back: 'Wolfberger' }],
    });
  });

  test('skipping the rescue commits exactly as before — front id only, no conflicts key', async () => {
    apiFetchMock.mockResolvedValue(jsonRes({
      bottle: { _id: 'b1', wineDefinition: { _id: 'w-new' }, vintage: '2019' },
      priceWarnings: [],
    }, true, 201));

    render(<AddBottle />);
    await deliverScan(PARTIAL);
    fireEvent.click(screen.getByText('addBottle.backScanSkip'));

    await act(async () => { fireEvent.click(screen.getByText('addBottle.scanConfirmWine')); });
    await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'), { target: { value: '2019' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });

    const { newWine } = JSON.parse(bottlesCalls()[0][1].body);
    expect(newWine.scanImageId).toBe('front-1');
    expect(newWine).not.toHaveProperty('scanImageBackId');
    expect(newWine).not.toHaveProperty('scanConflicts');
  });

  test('a wine that RESOLVES to the registry drops the evidence — there is nothing left to correct', async () => {
    resolveWine.mockResolvedValue(jsonRes({
      wine: { _id: 'w9', name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', type: 'white', grapes: [] },
      created: false,
    }));
    apiFetchMock.mockResolvedValue(jsonRes({
      bottle: { _id: 'b1', wineDefinition: { _id: 'w9' } }, priceWarnings: [],
    }, true, 201));

    render(<AddBottle />);
    await deliverScan(PARTIAL);
    await deliverBack(BACK_RESULT);
    await act(async () => { fireEvent.click(screen.getByText('addBottle.scanConfirmWine')); });
    await waitFor(() => expect(screen.getByText('addBottle.addBottleBtn')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('addBottle.vintagePlaceholder'), { target: { value: '2019' } });
    await act(async () => { fireEvent.click(screen.getByText('addBottle.addBottleBtn')); });

    const body = JSON.parse(bottlesCalls()[0][1].body);
    expect(body.wineDefinition).toBe('w9');
    expect(body.newWine).toBeUndefined();
  });
});
