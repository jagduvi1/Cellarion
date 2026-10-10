import { useRef } from 'react';
import { render, fireEvent, act } from '@testing-library/react';

// Tap to focus on a camera preview (support ticket 2026-10-10): a tap on the
// picture focuses at that point (x, y across the preview, 0–1) and shows the
// ring there; a tap on a button inside the viewfinder is left to the button.

// jsdom has no PointerEvent; without one a fired pointerdown carries no
// coordinates. A MouseEvent carries them, as a real pointer event does.
if (!window.PointerEvent) window.PointerEvent = class PointerEvent extends MouseEvent {};

const focusAt = vi.fn(async () => true);
vi.mock('../utils/camera', () => ({ focusAt: (...a) => focusAt(...a) }));

const { default: useTapToFocus } = await import('./useTapToFocus');
const { default: CameraFocusRing } = await import('../components/CameraFocusRing');

const STREAM = { id: 'stream' };
function Viewfinder() {
  const videoRef = useRef(null);
  const { onPointerDown, ring } = useTapToFocus(videoRef);
  return (
    <div data-testid="host" onPointerDown={onPointerDown}>
      <video data-testid="video" ref={(el) => { videoRef.current = el; if (el) el.srcObject = STREAM; }} />
      <CameraFocusRing ring={ring} />
      <button type="button">shutter</button>
    </div>
  );
}

const box = (el, rect) => { el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, ...rect }); };

beforeEach(() => focusAt.mockClear());

test('a tap on the picture focuses at that point and shows the ring where the finger was', async () => {
  const { getByTestId, container } = render(<Viewfinder />);
  box(getByTestId('host'), { left: 10, top: 20, width: 400, height: 300 });
  box(getByTestId('video'), { left: 10, top: 20, width: 400, height: 300 });
  await act(async () => {
    fireEvent.pointerDown(getByTestId('video'), { clientX: 110, clientY: 245 });
  });
  expect(focusAt).toHaveBeenCalledWith(STREAM, 0.25, 0.75);
  const ring = container.querySelector('.camera-focus-ring');
  expect(ring).not.toBeNull();
  expect(ring.style.left).toBe('100px');
  expect(ring.style.top).toBe('225px');
});

test('a tap on a button inside the viewfinder is left to the button', async () => {
  const { getByTestId, getByText } = render(<Viewfinder />);
  box(getByTestId('video'), { width: 400, height: 300 });
  await act(async () => { fireEvent.pointerDown(getByText('shutter'), { clientX: 50, clientY: 50 }); });
  expect(focusAt).not.toHaveBeenCalled();
});

test('no ring when the camera cannot be told where to focus', async () => {
  focusAt.mockResolvedValueOnce(false);
  const { getByTestId, container } = render(<Viewfinder />);
  box(getByTestId('host'), { width: 400, height: 300 });
  box(getByTestId('video'), { width: 400, height: 300 });
  await act(async () => { fireEvent.pointerDown(getByTestId('video'), { clientX: 200, clientY: 150 }); });
  expect(focusAt).toHaveBeenCalled();
  expect(container.querySelector('.camera-focus-ring')).toBeNull();
});
