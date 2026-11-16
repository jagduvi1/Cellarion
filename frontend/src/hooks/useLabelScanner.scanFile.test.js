import { renderHook, act, waitFor } from '@testing-library/react';

// A label photo chosen from the device goes through the same scan as a camera
// capture: scaled to at most 800 px, sent as JPEG to the front-label scan, and
// answered through the same callbacks. A photo that cannot be opened says so
// in the viewfinder and sends nothing.

vi.mock('../i18n', () => ({ default: { t: (k) => k } }));
vi.mock('../utils/track', () => ({ track: vi.fn() }));
vi.mock('../utils/camera', () => ({ openCamera: vi.fn(), isSuperseded: () => false }));
const scanLabel = vi.fn();
const scanLabelBack = vi.fn();
vi.mock('../api/wines', () => ({ scanLabel: (...a) => scanLabel(...a), scanLabelBack: (...a) => scanLabelBack(...a) }));

const { default: useLabelScanner } = await import('./useLabelScanner');

const drawImage = vi.fn();
const fillRect = vi.fn();
const ctx = { drawImage, fillRect, fillStyle: null };
let photoSize;
class FakeImage {
  set src(value) {
    setTimeout(() => {
      if (value === 'blob:bad') { this.onerror?.(); return; }
      this.naturalWidth = photoSize.w;
      this.naturalHeight = photoSize.h;
      this.onload?.();
    }, 0);
  }
}

beforeEach(() => {
  scanLabel.mockReset();
  scanLabelBack.mockReset();
  drawImage.mockReset();
  fillRect.mockReset();
  photoSize = { w: 1600, h: 1200 };
  vi.stubGlobal('Image', FakeImage);
  URL.createObjectURL = vi.fn((f) => (f.name === 'bad.jpg' ? 'blob:bad' : 'blob:ok'));
  URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx);
  HTMLCanvasElement.prototype.toBlob = function toBlob(cb, type) { cb(new Blob(['jpeg-bytes'], { type })); };
});

afterEach(() => { vi.unstubAllGlobals(); });

test('a chosen photo is scaled to 800 px and read as a front label', async () => {
  const data = { extracted: { name: 'Riesling' }, scanImageId: 's1' };
  scanLabel.mockResolvedValue({ ok: true, json: async () => data });
  const onScanSuccess = vi.fn();
  const apiFetch = vi.fn();
  const { result } = renderHook(() => useLabelScanner(apiFetch, { onScanSuccess }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'label.jpg', { type: 'image/jpeg' })); });

  await waitFor(() => expect(onScanSuccess).toHaveBeenCalledWith(data));
  expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 800, 600);
  expect(scanLabel).toHaveBeenCalledWith(apiFetch, expect.any(String), 'image/jpeg');
  expect(scanLabelBack).not.toHaveBeenCalled();
  expect(result.current.labelCam.open).toBe(false);
  expect(result.current.labelScanning).toBe(false);
});

test('a portrait photo is scaled on its longer edge', async () => {
  photoSize = { w: 600, h: 900 };
  scanLabel.mockResolvedValue({ ok: true, json: async () => ({ extracted: {} }) });
  const { result } = renderHook(() => useLabelScanner(vi.fn(), { onScanSuccess: vi.fn() }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'label.jpg')); });

  await waitFor(() => expect(scanLabel).toHaveBeenCalled());
  expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 533, 800);
});

test('an unreadable label goes to the error callback with the response body', async () => {
  const body = { error: 'Could not read', scanImageId: 's9' };
  scanLabel.mockResolvedValue({ ok: false, status: 422, headers: { get: () => null }, json: async () => body });
  const onScanError = vi.fn();
  const { result } = renderHook(() => useLabelScanner(vi.fn(), { onScanError }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'label.jpg')); });

  await waitFor(() => expect(onScanError).toHaveBeenCalledWith('Could not read', body));
});

test('a photo that cannot be opened says so and sends nothing', async () => {
  const onScanError = vi.fn();
  const { result } = renderHook(() => useLabelScanner(vi.fn(), { onScanError }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'bad.jpg')); });

  expect(result.current.labelCam).toEqual({ open: true, error: 'camera.photoUnreadable' });
  expect(result.current.labelScanning).toBe(false);
  expect(scanLabel).not.toHaveBeenCalled();
  expect(onScanError).not.toHaveBeenCalled();
});

test('a cut-out picture is read on white, not on the black a JPEG gives transparency', async () => {
  scanLabel.mockResolvedValue({ ok: true, json: async () => ({ extracted: {} }) });
  const { result } = renderHook(() => useLabelScanner(vi.fn(), { onScanSuccess: vi.fn() }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'bottle.png', { type: 'image/png' })); });

  await waitFor(() => expect(scanLabel).toHaveBeenCalled());
  expect(fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
  expect(fillRect.mock.invocationCallOrder[0]).toBeLessThan(drawImage.mock.invocationCallOrder[0]);
});

test('a photo the browser cannot draw says so instead of hanging on "reading the label"', async () => {
  // A phone's canvas memory limit: no 2D context to draw into.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
  const { result } = renderHook(() => useLabelScanner(vi.fn(), { onScanSuccess: vi.fn() }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'huge.jpg')); });

  expect(result.current.labelCam).toEqual({ open: true, error: 'camera.photoUnreadable' });
  expect(result.current.labelScanning).toBe(false);
  expect(scanLabel).not.toHaveBeenCalled();
});

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('closing the viewfinder while a photo is read drops the late answer', async () => {
  const late = deferred();
  scanLabel.mockReturnValue(late.promise);
  const onScanSuccess = vi.fn();
  const onScanError = vi.fn();
  const { result } = renderHook(() => useLabelScanner(vi.fn(), { onScanSuccess, onScanError }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'label.jpg')); });
  await waitFor(() => expect(scanLabel).toHaveBeenCalled());
  act(() => { result.current.stopCamera(); });
  expect(result.current.labelScanning).toBe(false);

  await act(async () => { late.resolve({ ok: true, json: async () => ({ extracted: { name: 'Too late' } }) }); });

  expect(onScanSuccess).not.toHaveBeenCalled();
  expect(onScanError).not.toHaveBeenCalled();
  expect(result.current.labelCam.open).toBe(false);
});

test('a second photo chosen meanwhile wins, and the first answer changes nothing', async () => {
  const first = deferred();
  const second = deferred();
  scanLabel.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const onScanSuccess = vi.fn();
  const { result } = renderHook(() => useLabelScanner(vi.fn(), { onScanSuccess }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'one.jpg')); });
  await waitFor(() => expect(scanLabel).toHaveBeenCalledTimes(1));
  await act(async () => { await result.current.scanFile(new File(['x'], 'two.jpg')); });
  await waitFor(() => expect(scanLabel).toHaveBeenCalledTimes(2));

  await act(async () => { first.resolve({ ok: true, json: async () => ({ extracted: { name: 'One' } }) }); });
  expect(onScanSuccess).not.toHaveBeenCalled();
  expect(result.current.labelScanning).toBe(true);

  await act(async () => { second.resolve({ ok: true, json: async () => ({ extracted: { name: 'Two' } }) }); });
  await waitFor(() => expect(onScanSuccess).toHaveBeenCalledTimes(1));
  expect(onScanSuccess).toHaveBeenCalledWith({ extracted: { name: 'Two' } });
  expect(result.current.labelScanning).toBe(false);
});
