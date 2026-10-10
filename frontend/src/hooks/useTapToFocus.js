import { useCallback, useEffect, useRef, useState } from 'react';
import { focusAt } from '../utils/camera';

/**
 * Tap to focus on a camera preview, as in a camera app (support ticket
 * 2026-10-10). Put `onPointerDown` on the element that holds the <video>
 * (position: relative) and render <CameraFocusRing ring={ring} /> inside it.
 * A tap on a button inside (shutter, close, switch) is left alone. The ring
 * shows only where the camera actually took the point.
 */
export default function useTapToFocus(videoRef) {
  const [ring, setRing] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onPointerDown = useCallback((e) => {
    if (e.target?.closest?.('button, a, input, select, textarea, label')) return;
    const video = videoRef.current;
    const stream = video?.srcObject;
    if (!video || !stream) return;
    const frame = video.getBoundingClientRect();
    const host = e.currentTarget.getBoundingClientRect();
    if (!frame.width || !frame.height || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    const x = Math.min(1, Math.max(0, (e.clientX - frame.left) / frame.width));
    const y = Math.min(1, Math.max(0, (e.clientY - frame.top) / frame.height));
    const at = { left: e.clientX - host.left, top: e.clientY - host.top, key: Date.now() };
    focusAt(stream, x, y).then((ok) => {
      if (!ok) return;
      setRing(at);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setRing(null), 900);
    });
  }, [videoRef]);

  return { onPointerDown, ring };
}
