/**
 * AddToWishlist — a back-label rescan after the front scan flagged the producer.
 *
 * Same rule as AddBottle: a suspect producer is the one prefill the back label
 * may REPLACE, as long as the box still holds the exact flagged string. The
 * handler also records the merge's own verdict in the ref the replacement
 * compares against, and the form updater runs only at the next render — so
 * the comparison has to use the value the ref held when the back scan arrived.
 *
 * The camera hook is mocked to a callback captor: the page's reaction to a
 * scan result is what is under test, not getUserMedia.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';

const { apiFetchMock, scannerRef } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  scannerRef: { current: {} },
}));

vi.mock('../api/wines', () => ({
  searchWines: vi.fn(),
  getWine: vi.fn(),
  resolveWine: vi.fn(),
  identifyWineByText: vi.fn(),
}));
vi.mock('../api/bridge', () => ({ adoptRegistryWine: vi.fn() }));
vi.mock('../api/wishlist', () => ({ addToWishlist: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: apiFetchMock, user: { preferences: { currency: 'USD' } } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ state: null, search: '' }),
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

vi.mock('react-i18next', () => {
  const t = (key) => key;
  const Trans = ({ i18nKey }) => <span>{i18nKey}</span>;
  return { useTranslation: () => ({ t }), Trans };
});

const AddToWishlist = (await import('./AddToWishlist')).default;

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
});

const deliverScan = (data) => act(async () => { scannerRef.current.onScanSuccess(data); });
const deliverBack = (data) => act(async () => { scannerRef.current.onBackScanSuccess(data); });
const producerInput = () => screen.getByPlaceholderText('addToWishlist.producerOptionalPlaceholder');

test('the back label replaces a flagged producer the user left alone', async () => {
  render(<AddToWishlist />);
  await deliverScan(SUSPECT_FRONT);
  expect(producerInput()).toHaveValue('Alsace Grand Cru');
  expect(screen.getByText('addToWishlist.producerSuspectNote')).toBeInTheDocument();

  await deliverBack(BACK_RESULT);

  expect(producerInput()).toHaveValue('Cave de Kaysersberg');
  // The merge cleared the suspicion, so the note goes with it.
  expect(screen.queryByText('addToWishlist.producerSuspectNote')).not.toBeInTheDocument();
});

test('a producer the user typed survives the back label', async () => {
  render(<AddToWishlist />);
  await deliverScan(SUSPECT_FRONT);
  fireEvent.change(producerInput(), { target: { value: 'Typed Producer' } });

  await deliverBack(BACK_RESULT);

  expect(producerInput()).toHaveValue('Typed Producer');
});
