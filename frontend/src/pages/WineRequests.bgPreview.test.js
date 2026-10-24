import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import WineRequests from './WineRequests';

// A wine request's front photo gets a background-removed preview, and the
// request sends that cut-out with the photo. When the member retakes the photo
// (or removes it) while a preview is still running, the late preview belongs
// to a photo that is no longer in the form: it must not be shown or sent.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, dv) => (typeof dv === 'string' ? dv : key) }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const PHOTO_A = new File(['a'], 'a.jpg', { type: 'image/jpeg' });
const PHOTO_B = new File(['b'], 'b.jpg', { type: 'image/jpeg' });

// The camera needs media APIs jsdom lacks; this stand-in hands the form a
// chosen file and shows what the form gives back.
vi.mock('../components/PhotoCapture', () => ({
  default: ({ onCapture, onRemove, processedUrl, processing }) => (
    <div data-testid="photo-capture">
      <button type="button" onClick={() => onCapture(PHOTO_A)}>take photo A</button>
      <button type="button" onClick={() => onCapture(PHOTO_B)}>take photo B</button>
      <button type="button" onClick={onRemove}>remove photo</button>
      {processedUrl && <span>{`preview: ${processedUrl}`}</span>}
      {processing && <span>processing</span>}
    </div>
  ),
}));

// The encode to the server's cap needs a canvas; what matters here is which
// cut-out and which file it is handed.
vi.mock('../utils/requestImage', () => ({
  requestImageFor: vi.fn(async ({ preview, file }) => (preview ? `sent:${preview}` : `sent:${file.name}`)),
}));
const { requestImageFor } = await import('../utils/requestImage');

const jsonRes = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const cutOut = (name) => ({ ok: true, status: 200, json: () => Promise.resolve({ processedImage: name }) });

// The form shrinks the photo on a canvas before it asks for the preview.
class FakeImage {
  constructor() { this.naturalWidth = 1200; this.naturalHeight = 1600; this.onload = null; }
  set src(value) { this._src = value; setTimeout(() => this.onload && this.onload(), 0); }
  get src() { return this._src; }
}

let previews;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Image', FakeImage);
  URL.createObjectURL = vi.fn(() => 'blob:photo');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');
  previews = [];
  apiFetch.mockImplementation((url, opts) => {
    if (url === '/api/images/remove-bg-preview') {
      const d = deferred();
      previews.push(d);
      return d.promise;
    }
    if (opts && opts.method === 'POST') return jsonRes({ wineRequest: {} });
    return jsonRes({ requests: [] });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

async function openForm() {
  render(<WineRequests />);
  fireEvent.click(await screen.findByText('+ wineRequests.newRequest'));
  // The first photo field is the front label, the one with a preview.
  return within(screen.getAllByTestId('photo-capture')[0]);
}

async function takeAThenB(front) {
  fireEvent.click(front.getByText('take photo A'));
  await waitFor(() => expect(previews).toHaveLength(1));
  fireEvent.click(front.getByText('take photo B'));
  await waitFor(() => expect(previews).toHaveLength(2));
}

const submitButton = () => screen.getByText('wineRequests.submitRequest');

test("photo A's preview answering after photo B's is dropped, and the request sends B's cut-out", async () => {
  const front = await openForm();
  await takeAThenB(front);

  await act(async () => { previews[1].resolve(cutOut('cutout-B')); });
  expect(await front.findByText('preview: cutout-B')).toBeInTheDocument();
  await act(async () => { previews[0].resolve(cutOut('cutout-A')); });
  expect(front.queryByText('preview: cutout-A')).toBeNull();
  expect(front.getByText('preview: cutout-B')).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('wineRequests.wineNamePlaceholder'), { target: { value: 'Example Wine 2019' } });
  fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: 'https://winery.example/w' } });
  fireEvent.click(submitButton());
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/wine-requests', expect.objectContaining({ method: 'POST' })));
  expect(requestImageFor).toHaveBeenCalledWith({ preview: 'cutout-B', file: PHOTO_B });
  const sent = JSON.parse(apiFetch.mock.calls.find((c) => c[0] === '/api/wine-requests' && c[1]?.method === 'POST')[1].body);
  expect(sent.image).toBe('sent:cutout-B');
});

test("photo A's preview finishing first does not end photo B's: no preview yet, and the form waits", async () => {
  const front = await openForm();
  await takeAThenB(front);

  await act(async () => { previews[0].resolve(cutOut('cutout-A')); });
  expect(front.queryByText('preview: cutout-A')).toBeNull();
  expect(front.getByText('processing')).toBeInTheDocument();
  expect(submitButton()).toBeDisabled();

  await act(async () => { previews[1].resolve(cutOut('cutout-B')); });
  expect(await front.findByText('preview: cutout-B')).toBeInTheDocument();
  expect(front.queryByText('processing')).toBeNull();
  expect(submitButton()).not.toBeDisabled();
});

test('a preview that answers after the photo was removed does not come back', async () => {
  const front = await openForm();
  fireEvent.click(front.getByText('take photo A'));
  await waitFor(() => expect(previews).toHaveLength(1));

  fireEvent.click(front.getByText('remove photo'));
  expect(front.queryByText('processing')).toBeNull();
  await act(async () => { previews[0].resolve(cutOut('cutout-A')); });
  expect(front.queryByText('preview: cutout-A')).toBeNull();
  expect(front.queryByText('processing')).toBeNull();
});
