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
  photoSize = { w: 1600, h: 1200 };
  vi.stubGlobal('Image', FakeImage);
  URL.createObjectURL = vi.fn((f) => (f.name === 'bad.jpg' ? 'blob:bad' : 'blob:ok'));
  URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage }));
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

test('a small photo is sent at its own size', async () => {
  photoSize = { w: 600, h: 900 };
  scanLabel.mockResolvedValue({ ok: true, json: async () => ({ extracted: {} }) });
  const { result } = renderHook(() => useLabelScanner(vi.fn(), { onScanSuccess: vi.fn() }));

  await act(async () => { await result.current.scanFile(new File(['x'], 'label.jpg')); });

  await waitFor(() => expect(scanLabel).toHaveBeenCalled());
  expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 533, 800);
});

test('an unreadable label goes to the error callback with the response body', async () => {
  const body = { error: 'Could not read', scanImageId: 's9' };
  scanLabel.mockResolvedValue({ ok: false, json: async () => body });
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
