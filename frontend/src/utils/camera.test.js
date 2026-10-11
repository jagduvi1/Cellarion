import { openCamera, focusAt, canAutofocus, reportsFocus, isSuperseded } from './camera';

// The phone camera for a label or a barcode (support ticket 2026-10-10: an
// Android preview never came into focus). Pinned: continuous autofocus is
// asked for where offered; a rear lens that cannot focus at all is swapped
// for one that can, and the outcome — that lens, or "none better" — is
// remembered so later openings are a single open; a busy camera is retried,
// not forgotten; a browser that reports no focus modes never cycles through
// cameras; only the newest open delivers a camera; tap to focus goes to the
// point and back to continuous, and a new tap replaces an earlier one.

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

const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
let cameras;
let getUserMedia;
let enumeratedWhileLive;
let live; // the streams handed out and not stopped
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  cameras = {};
  live = new Set();
  enumeratedWhileLive = null;
  getUserMedia = vi.fn(async ({ video }) => {
    const id = video.deviceId?.exact || 'default';
    const make = cameras[id];
    if (!make) throw Object.assign(new Error('no such camera'), { name: 'OverconstrainedError' });
    if (make.busy && make.busy-- > 0) throw Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
    const s = make();
    live.add(s);
    s.track.stop.mockImplementation(function stop() { this.readyState = 'ended'; live.delete(s); });
    return s;
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => {
        enumeratedWhileLive = live.size > 0;
        return Object.keys(cameras).filter((k) => k !== 'default').map((deviceId) => ({
          kind: 'videoinput', deviceId, label: cameras[deviceId].label || `camera2 ${deviceId}, facing back`,
        }));
      },
      getSupportedConstraints: () => ({ pointsOfInterest: true }),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (original) Object.defineProperty(navigator, 'mediaDevices', original);
  else delete navigator.mediaDevices;
});

const opened = () => getUserMedia.mock.calls.map(([c]) => c.video.deviceId?.exact || 'default');
const remembered = () => window.localStorage.getItem('cellarion.autofocusCamera');
const CONT = { advanced: [{ focusMode: 'continuous' }] };

test('a camera with autofocus is opened once and asked for continuous focus', async () => {
  cameras.default = () => fakeStream({ id: 'main', focusMode: ['manual', 'single-shot', 'continuous'] });
  const s = await openCamera();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(getUserMedia.mock.calls[0][0].video).toEqual({ facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } });
  expect(s.track.applied).toEqual([CONT]);
  expect(remembered()).toBeNull();
});

test('a rear lens that cannot focus at all is swapped for one that can, found while the camera is live, and remembered', async () => {
  cameras.default = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.wide = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.front = Object.assign(() => fakeStream({ id: 'front', focusMode: ['continuous'], facingMode: 'user' }), { label: 'camera2 1, facing front' });
  cameras.main = () => fakeStream({ id: 'main', focusMode: ['continuous'] });
  const s = await openCamera();
  expect(s.id).toBe('main');
  expect(s.track.applied).toEqual([CONT]);
  expect(remembered()).toBe('main');
  // The lens list was read while a camera was on (labels known), and the
  // front camera was never opened for the rear view.
  expect(enumeratedWhileLive).toBe(true);
  expect(opened()).not.toContain('front');
  expect([...live]).toEqual([s]);

  // Next time: straight to the remembered lens, nothing else opened.
  getUserMedia.mockClear();
  const again = await openCamera();
  expect(again.id).toBe('main');
  expect(opened()).toEqual(['main']);
});

test('a lens with single-shot focus only is kept (a tap focuses it) — no search', async () => {
  cameras.default = () => fakeStream({ id: 'main', focusMode: ['manual', 'single-shot'] });
  cameras.other = () => fakeStream({ id: 'other', focusMode: ['continuous'] });
  const s = await openCamera();
  expect(s.id).toBe('main');
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

test('no lens focuses better: the default is opened again, and "none better" is remembered so the search never repeats', async () => {
  cameras.default = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.tele = () => fakeStream({ id: 'tele', focusMode: ['manual'] });
  const s = await openCamera();
  expect(s.id).toBe('wide');
  expect(remembered()).toBe('default');

  getUserMedia.mockClear();
  await openCamera();
  expect(opened()).toEqual(['default']);
});

test('a lens that was busy during the search is retried once, and an unfinished search is not taken as "none better"', async () => {
  cameras.default = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  // Busy twice: the retry fails too, so the search could not look at it.
  cameras.main = Object.assign(() => fakeStream({ id: 'main', focusMode: ['continuous'] }), { busy: 2 });
  const s = await openCamera();
  expect(s.id).toBe('wide');
  expect(opened().filter((id) => id === 'main')).toHaveLength(2);
  expect(remembered()).toBeNull();
});

test('a camera still closing (busy once) is opened on the retry', async () => {
  cameras.default = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.main = Object.assign(() => fakeStream({ id: 'main', focusMode: ['continuous'] }), { busy: 1 });
  const s = await openCamera();
  expect(s.id).toBe('main');
  expect(remembered()).toBe('main');
});

test('a browser that reports no focus modes (iPhone, Firefox) opens the camera once, as before', async () => {
  cameras.default = () => fakeStream({ id: 'cam', focusMode: undefined });
  const s = await openCamera();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(reportsFocus(s)).toBe(false);
  expect(canAutofocus(s)).toBe(false);
  expect(s.track.applied).toEqual([]);
});

test('a remembered lens that is gone is forgotten, and a fixed-focus default then gets the search', async () => {
  window.localStorage.setItem('cellarion.autofocusCamera', 'old-phone');
  cameras.default = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.main = () => fakeStream({ id: 'main', focusMode: ['continuous'] });
  const s = await openCamera();
  expect(s.id).toBe('main');
  expect(remembered()).toBe('main');
});

test('a remembered lens that is busy is kept for next time; this time the default opens, without a search', async () => {
  window.localStorage.setItem('cellarion.autofocusCamera', 'main');
  cameras.default = () => fakeStream({ id: 'wide', focusMode: ['manual'] });
  cameras.main = Object.assign(() => fakeStream({ id: 'main', focusMode: ['continuous'] }), { busy: 2 });
  const s = await openCamera();
  expect(s.id).toBe('wide');
  expect(remembered()).toBe('main');
  expect(opened()).toEqual(['main', 'main', 'default']);
});

test('a remembered lens that no longer focuses (or faces front) is dropped', async () => {
  window.localStorage.setItem('cellarion.autofocusCamera', 'main');
  cameras.main = () => fakeStream({ id: 'main', focusMode: ['continuous'], facingMode: 'user' });
  cameras.default = () => fakeStream({ id: 'back', focusMode: ['continuous'] });
  const s = await openCamera();
  expect(s.id).toBe('back');
  expect(remembered()).toBeNull();
});

test('a refused permission is passed on; no camera API at all reads as "no camera"', async () => {
  window.localStorage.setItem('cellarion.autofocusCamera', 'main');
  cameras.main = () => fakeStream({ id: 'main', focusMode: ['continuous'] });
  getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  await expect(openCamera()).rejects.toMatchObject({ name: 'NotAllowedError' });

  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  await expect(openCamera()).rejects.toMatchObject({ name: 'NotFoundError' });
});

test('the front camera gets no lens search', async () => {
  cameras.default = () => fakeStream({ id: 'front', focusMode: ['manual'], facingMode: 'user' });
  const s = await openCamera({ facingMode: 'user', width: 1280, height: 720 });
  expect(s.id).toBe('front');
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(getUserMedia.mock.calls[0][0].video).toEqual({ facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } });
});

test('only the newest open delivers a camera: an earlier one that finishes later stops its stream and says so', async () => {
  let release;
  cameras.default = () => fakeStream({ id: 'back', focusMode: ['continuous'] });
  getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(fakeStream({ id: 'slow', focusMode: ['continuous'] })); }));
  const first = openCamera();
  const second = await openCamera({ facingMode: 'user' });
  expect(second.id).toBe('back');
  release();
  const err = await first.catch((e) => e);
  expect(isSuperseded(err)).toBe(true);
});

describe('tap to focus', () => {
  test('one shot at the point, then back to continuous there', async () => {
    vi.useFakeTimers();
    const s = fakeStream({ focusMode: ['single-shot', 'continuous'] });
    expect(await focusAt(s, 0.25, 0.75)).toBe(true);
    expect(s.track.applied).toEqual([{ advanced: [{ pointsOfInterest: [{ x: 0.25, y: 0.75 }], focusMode: 'single-shot' }] }]);
    vi.advanceTimersByTime(2600);
    expect(s.track.applied[1]).toEqual({ advanced: [{ pointsOfInterest: [{ x: 0.25, y: 0.75 }], focusMode: 'continuous' }] });
  });

  test('a new tap replaces the earlier one: its return to continuous never pulls focus back', async () => {
    vi.useFakeTimers();
    const s = fakeStream({ focusMode: ['single-shot', 'continuous'] });
    await focusAt(s, 0.1, 0.1);
    vi.advanceTimersByTime(2000);
    await focusAt(s, 0.9, 0.9);
    vi.advanceTimersByTime(600); // the first tap's timer would have fired here
    expect(s.track.applied.some((c) => c.advanced[0].focusMode === 'continuous')).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(s.track.applied.at(-1)).toEqual({ advanced: [{ pointsOfInterest: [{ x: 0.9, y: 0.9 }], focusMode: 'continuous' }] });
  });

  test('nothing for a camera that cannot focus at all, whatever the browser lists', async () => {
    const fixed = fakeStream({ focusMode: ['manual'] });
    expect(await focusAt(fixed, 0.5, 0.5)).toBe(false);
    expect(fixed.track.applied).toEqual([]);
    expect(await focusAt(fakeStream({ focusMode: undefined }), 0.5, 0.5)).toBe(false);
  });

  test('a continuous-only camera is pointed at the spot, without a single shot', async () => {
    const s = fakeStream({ focusMode: ['continuous'] });
    expect(await focusAt(s, 0.3, 0.4)).toBe(true);
    expect(s.track.applied).toEqual([{ advanced: [{ pointsOfInterest: [{ x: 0.3, y: 0.4 }] }] }]);
  });
});
