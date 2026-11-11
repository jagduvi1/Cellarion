import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import WineRequests from './WineRequests';

// A photo the browser cannot decode (a HEIC on most desktops, a broken
// download) never "loads". The form must come back from that: the preview
// stops, Submit works again, and a submit says what is wrong with the photo
// instead of sending nothing with a general failure.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, dv) => (typeof dv === 'string' ? dv : key) }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const PHOTO = new File(['not an image'], 'holiday.heic', { type: 'image/heic' });

vi.mock('../components/PhotoCapture', () => ({
  default: ({ onCapture, processing }) => (
    <div data-testid="photo-capture">
      <button type="button" onClick={() => onCapture(PHOTO)}>take the photo</button>
      {processing && <span>processing</span>}
    </div>
  ),
}));

vi.mock('../utils/requestImage', () => ({
  requestImageFor: vi.fn(async () => { throw new Error('image could not be read'); }),
}));

// An image element that fails to decode whatever it is given.
class UnreadableImage {
  constructor() { this.onload = null; this.onerror = null; }
  set src(value) { this._src = value; setTimeout(() => this.onerror && this.onerror(new Event('error')), 0); }
  get src() { return this._src; }
}

const jsonRes = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });

let alerts;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Image', UnreadableImage);
  URL.createObjectURL = vi.fn(() => 'blob:photo');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  alerts = vi.spyOn(window, 'alert').mockImplementation(() => {});
  apiFetch.mockImplementation((url, opts) => (opts && opts.method === 'POST' ? jsonRes({ wineRequest: {} }) : jsonRes({ requests: [] })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

async function takeThePhoto() {
  render(<WineRequests />);
  fireEvent.click(await screen.findByText('+ wineRequests.newRequest'));
  const front = within(screen.getAllByTestId('photo-capture')[0]);
  fireEvent.click(front.getByText('take the photo'));
  return front;
}
const submitButton = () => screen.getByText('wineRequests.submitRequest');
const posts = () => apiFetch.mock.calls.filter(([, opts]) => opts && opts.method === 'POST');

test('a photo that cannot be decoded ends the preview and leaves Submit usable', async () => {
  const front = await takeThePhoto();
  await waitFor(() => expect(front.queryByText('processing')).toBeNull());
  expect(submitButton()).not.toBeDisabled();
  // nothing was sent for a cut-out, and the temporary address of the file is released
  expect(posts()).toHaveLength(0);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
});

test('submitting with that photo says the photo could not be read and sends nothing', async () => {
  const front = await takeThePhoto();
  await waitFor(() => expect(front.queryByText('processing')).toBeNull());
  fireEvent.change(screen.getByPlaceholderText('wineRequests.wineNamePlaceholder'), { target: { value: 'Example Wine 2019' } });
  fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: 'https://winery.example/w' } });
  fireEvent.click(submitButton());

  await waitFor(() => expect(alerts).toHaveBeenCalledWith('wineRequests.photoUnreadable'));
  expect(posts()).toHaveLength(0);
  // the form is still there to change the photo, and Submit works again
  await waitFor(() => expect(submitButton()).not.toBeDisabled());
});
