import { useRef } from 'react';
import { render, fireEvent, act } from '@testing-library/react';

// Tap to focus on a camera preview (support ticket 2026-10-10): a tap on the
// picture focuses at that point of the camera FRAME — through the preview's
// object-fit scaling, since part of the frame is cropped off — and shows the
// ring where the finger was. A tap on a button or the controls bar, a second
// finger, another mouse button or a tap off the picture is left alone.

const focusAt = vi.fn(async () => true);
vi.mock('../utils/camera', () => ({ focusAt: (...a) => focusAt(...a) }));

const { default: useTapToFocus, framePoint } = await import('./useTapToFocus');
const { default: CameraFocusRing } = await import('../components/CameraFocusRing');

// jsdom has no PointerEvent; without one a fired pointerdown carries no
// coordinates. A MouseEvent carries them, as a real pointer event does.
let addedPointerEvent = false;
beforeAll(() => {
  if (!window.PointerEvent) {
    window.PointerEvent = class PointerEvent extends MouseEvent {
      constructor(type, init = {}) { super(type, init); this.isPrimary = init.isPrimary ?? true; }
    };
    addedPointerEvent = true;
  }
});
afterAll(() => { if (addedPointerEvent) delete window.PointerEvent; });

const STREAM = { id: 'stream' };
function Viewfinder() {
  const videoRef = useRef(null);
  const { onPointerDown, ring } = useTapToFocus(videoRef);
  return (
    <div data-testid="host" onPointerDown={onPointerDown}>
      <video data-testid="video" ref={(el) => { videoRef.current = el; if (el) el.srcObject = STREAM; }} />
      <CameraFocusRing ring={ring} />
      <div className="camera-controls" data-testid="controls"><button type="button">shutter</button></div>
    </div>
  );
}

const box = (el, rect) => { el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, ...rect }); };
const mount = () => {
  const view = render(<Viewfinder />);
  box(view.getByTestId('host'), { left: 10, top: 20, width: 400, height: 300 });
  box(view.getByTestId('video'), { left: 10, top: 20, width: 400, height: 300 });
  return view;
};
const tap = async (el, init) => { await act(async () => { fireEvent.pointerDown(el, { button: 0, ...init }); }); };

beforeEach(() => focusAt.mockClear());

test('a tap on the picture focuses at that point and shows the ring where the finger was', async () => {
  const { getByTestId, container } = mount();
  await tap(getByTestId('video'), { clientX: 110, clientY: 245 });
  expect(focusAt).toHaveBeenCalledWith(STREAM, 0.25, 0.75);
  const ring = container.querySelector('.camera-focus-ring');
  expect(ring).not.toBeNull();
  expect(ring.style.left).toBe('100px');
  expect(ring.style.top).toBe('225px');
});

test('the point is in the camera frame, through the preview\'s cropping (object-fit: cover)', () => {
  // A portrait 1080×1920 stream in a 380×420 box: the frame is scaled to
  // 380 wide (675.6 tall), so about 128 px are cropped above and below.
  const video = { videoWidth: 1080, videoHeight: 1920 };
  const rect = { left: 0, top: 0, width: 380, height: 420 };
  const top = framePoint(video, rect, 190, 0);
  expect(top.x).toBeCloseTo(0.5, 3);
  expect(top.y).toBeCloseTo(0.189, 2);
  expect(framePoint(video, rect, 190, 420).y).toBeCloseTo(0.811, 2);
  // Not playing yet (no size): the box itself.
  expect(framePoint({ videoWidth: 0, videoHeight: 0 }, rect, 95, 105)).toEqual({ x: 0.25, y: 0.25 });
});

test('a tap on a button or the controls bar is left to them', async () => {
  const { getByText, getByTestId } = mount();
  await tap(getByText('shutter'), { clientX: 50, clientY: 50 });
  await tap(getByTestId('controls'), { clientX: 60, clientY: 300 });
  expect(focusAt).not.toHaveBeenCalled();
});

test('a second finger, another mouse button or a tap off the picture does nothing', async () => {
  const { getByTestId } = mount();
  await tap(getByTestId('video'), { clientX: 110, clientY: 245, isPrimary: false });
  await tap(getByTestId('video'), { clientX: 110, clientY: 245, button: 2 });
  await tap(getByTestId('host'), { clientX: 500, clientY: 245 });
  expect(focusAt).not.toHaveBeenCalled();
});

test('no ring when the camera cannot be told where to focus', async () => {
  focusAt.mockResolvedValueOnce(false);
  const { getByTestId, container } = mount();
  await tap(getByTestId('video'), { clientX: 200, clientY: 150 });
  expect(focusAt).toHaveBeenCalled();
  expect(container.querySelector('.camera-focus-ring')).toBeNull();
});
