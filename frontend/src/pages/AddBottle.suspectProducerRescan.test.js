/**
 * AddBottle — a back-label rescan after the front scan flagged the producer.
 *
 * A suspect producer (a place or label text where the winery should be) is the
 * one prefill the back label may REPLACE, as long as the box still holds the
 * exact flagged string. The handler also records the merge's own verdict in
 * the same ref the replacement compares against, and React runs the form
 * updater only at the next render — so the comparison has to use the value
 * the ref held when the back scan arrived.
 *
 * Same camera-hook captor as AddBottle.backLabelScan.test.js.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';

const { apiFetchMock, scannerRef } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
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
  useNavigate: () => vi.fn(),
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

vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const { searchWines } = await import('../api/wines');
const AddBottle = (await import('./AddBottle')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

/** Every field read, but the producer box holds a place, not a winery. */
const SUSPECT_FRONT = {
  extracted: {
    name: 'Kaefferkopf', producer: 'Alsace Grand Cru', country: 'France', region: 'Alsace',
    appellation: '', type: 'white', grapes: [], partial: true,
    producer_suspect: 'producer-is-appellation.v1',
  },
  match: null,
  labelImage: null,
  scanImageId: 'front-1',
};

/** The back label named the real producer, and the merge no longer suspects it. */
const BACK_RESULT = {
  merged: {
    name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France',
    region: 'Alsace', appellation: '', type: 'white', grapes: ['Riesling'],
  },
  conflicts: [],
  filled: ['producer', 'grapes'],
  match: null,
  backScanImageId: 'back-1',
  frontScanImageId: 'front-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  searchWines.mockResolvedValue(jsonRes({ wines: [] }));
});

const deliverScan = (data) => act(async () => { scannerRef.current.onScanSuccess(data); });
const deliverBack = (data) => act(async () => { scannerRef.current.onBackScanSuccess(data); });
const producerInput = () => screen.getByPlaceholderText('addBottle.scanProducerOptionalPlaceholder');

test('the back label replaces a flagged producer the user left alone', async () => {
  render(<AddBottle />);
  await deliverScan(SUSPECT_FRONT);
  expect(producerInput()).toHaveValue('Alsace Grand Cru');
  expect(screen.getByText('addBottle.producerSuspectNote')).toBeInTheDocument();

  await deliverBack(BACK_RESULT);

  expect(producerInput()).toHaveValue('Cave de Kaysersberg');
  // The merge cleared the suspicion, so the note goes with it.
  expect(screen.queryByText('addBottle.producerSuspectNote')).not.toBeInTheDocument();
});

test('a producer the user typed survives the back label', async () => {
  render(<AddBottle />);
  await deliverScan(SUSPECT_FRONT);
  fireEvent.change(producerInput(), { target: { value: 'Typed Producer' } });

  await deliverBack(BACK_RESULT);

  expect(producerInput()).toHaveValue('Typed Producer');
});
