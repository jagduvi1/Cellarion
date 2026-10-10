import { openCamera, focusAt, canAutofocus, reportsFocus } from './camera';

// The phone camera for a label or a barcode (support ticket 2026-10-10: a
// Samsung preview never came into focus). Pinned: continuous autofocus is
// switched on where offered; a rear lens without autofocus is swapped for
// one that has it, once, and remembered; a browser that reports no focus
// modes never cycles through cameras; tap to focus goes to the point and
// back to continuous.

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};

// A fake camera: its focus modes, its id, what applyConstraints received.
function fakeStream({ id = 'cam-0', focusMode, facingMode = 'environment' } = {}) {
  const track = {
    readyState: 'live',
    applied: [],
    stop: vi.fn(function stop() { this.readyState = 'ended'; }),
    getCapabilities: () => (focusMode === undefined ? {} : { focusMode }),
    getSettings: () => ({ deviceId: id, facingMode }),
    applyConstraints: vi.fn(async function apply(c) { this.applied.push(c); }),
  };
  return { id, track, getVideoTracks: () => [track], getTracks: () => [track] };
}

let cameras;
let getUserMedia;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  cameras = {};
  getUserMedia = vi.fn(async ({ video }) => {
    const id = video.deviceId?.exact || 'default';
    if (!cameras[id]) throw Object.assign(new Error('no such camera'), { name: 'OverconstrainedError' });
    return cameras[id]();
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => Object.keys(cameras).filter((k) => k !== 'default').map((deviceId) => ({
        kind: 'videoinput', deviceId, label: cameras[deviceId].label || `camera2 ${deviceId}, facing back`,
      })),
      getSupportedConstraints: () => ({ pointsOfInterest: true }),
    },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('a camera with autofocus is opened once and switched to continuous focus', async () => {
  cameras.default = () => fakeStream({ id: 'main', focusMode: ['manual', 'single-shot', 'continuous'] });
  const s = await openCamera();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(getUserMedia.mock.calls[0][0].video).toEqual({ facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } });
  expect(s.track.applied).toEqual([{ advanced: [{ focusMode: 'continuous' }] }]);
});

test('a rear lens that reports no autofocus is swapped for one that has it, and the choice is remembered', async () => {
  cameras.default = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.wide = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.front = Object.assign(() => fakeStream({ id: 'front', focusMode: ['continuous'], facingMode: 'user' }), { label: 'camera2 1, facing front' });
  cameras.main = () => fakeStream({ id: 'main', focusMode: ['continuous'] });
  const s = await openCamera();
  expect(s.id).toBe('main');
  expect(s.track.applied).toEqual([{ advanced: [{ focusMode: 'continuous' }] }]);
  expect(window.localStorage.getItem('cellarion.autofocusCamera')).toBe('main');
  // The front camera was never tried for the rear view.
  expect(getUserMedia.mock.calls.map(([c]) => c.video.deviceId?.exact).filter(Boolean)).not.toContain('front');

  // Next time: straight to the remembered lens, nothing else opened.
  getUserMedia.mockClear();
  const again = await openCamera();
  expect(again.id).toBe('main');
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(getUserMedia.mock.calls[0][0].video.deviceId).toEqual({ exact: 'main' });
});

test('no lens with autofocus: the default camera is opened again and nothing is remembered', async () => {
  cameras.default = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.tele = () => fakeStream({ id: 'tele', focusMode: ['manual'] });
  const s = await openCamera();
  expect(s.id).toBe('wide');
  expect(window.localStorage.getItem('cellarion.autofocusCamera')).toBeNull();
});

test('a browser that reports no focus modes (iPhone, Firefox) opens the camera once, as before', async () => {
  cameras.default = () => fakeStream({ id: 'cam', focusMode: undefined });
  const s = await openCamera();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(reportsFocus(s)).toBe(false);
  expect(canAutofocus(s)).toBe(false);
  expect(s.track.applied).toEqual([]);
});

test('a remembered lens that is gone is forgotten and the default opens; a refused permission is passed on', async () => {
  window.localStorage.setItem('cellarion.autofocusCamera', 'old-phone');
  cameras.default = () => fakeStream({ id: 'main', focusMode: ['continuous'] });
  const s = await openCamera();
  expect(s.id).toBe('main');
  expect(window.localStorage.getItem('cellarion.autofocusCamera')).toBeNull();

  window.localStorage.setItem('cellarion.autofocusCamera', 'main');
  getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  await expect(openCamera()).rejects.toMatchObject({ name: 'NotAllowedError' });
});

test('the front camera is never swapped and gets no lens search', async () => {
  cameras.default = () => fakeStream({ id: 'front', focusMode: ['manual'], facingMode: 'user' });
  const s = await openCamera({ facingMode: 'user', width: 1280, height: 720 });
  expect(s.id).toBe('front');
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(getUserMedia.mock.calls[0][0].video).toEqual({ facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } });
});

test('tap to focus: one shot at the point, then back to continuous there', async () => {
  vi.useFakeTimers();
  const s = fakeStream({ focusMode: ['single-shot', 'continuous'] });
  expect(await focusAt(s, 0.25, 0.75)).toBe(true);
  expect(s.track.applied).toEqual([{ advanced: [{ pointsOfInterest: [{ x: 0.25, y: 0.75 }], focusMode: 'single-shot' }] }]);
  vi.advanceTimersByTime(2600);
  expect(s.track.applied[1]).toEqual({ advanced: [{ pointsOfInterest: [{ x: 0.25, y: 0.75 }], focusMode: 'continuous' }] });
});

test('tap to focus does nothing on a camera that cannot be told where to focus', async () => {
  navigator.mediaDevices.getSupportedConstraints = () => ({});
  const s = fakeStream({ focusMode: ['continuous'] });
  expect(await focusAt(s, 0.5, 0.5)).toBe(false);
  expect(s.track.applied).toEqual([]);
  expect(await focusAt(fakeStream({ focusMode: undefined }), 0.5, 0.5)).toBe(false);
});
