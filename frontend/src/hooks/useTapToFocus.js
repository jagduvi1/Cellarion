import { useCallback, useEffect, useRef, useState } from 'react';
import { focusAt } from '../utils/camera';

const clamp = (v) => Math.min(1, Math.max(0, v));

/**
 * Where in the camera frame a tap landed (0–1 across and down). The preview
 * fills its box with object-fit: cover (or contain), so the frame is scaled
 * and part of it is cropped off: the tap goes through the same scaling, or
 * focus would land beside what the finger touched.
 */
export function framePoint(video, rect, clientX, clientY) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let fit = 'cover';
  try { fit = window.getComputedStyle(video).objectFit || 'cover'; } catch { /* keep cover */ }
  if (!vw || !vh || (fit !== 'cover' && fit !== 'contain')) {
    return { x: clamp((clientX - rect.left) / rect.width), y: clamp((clientY - rect.top) / rect.height) };
  }
  const scale = fit === 'cover'
    ? Math.max(rect.width / vw, rect.height / vh)
    : Math.min(rect.width / vw, rect.height / vh);
  const shownW = vw * scale;
  const shownH = vh * scale;
  const left = rect.left + (rect.width - shownW) / 2;
  const top = rect.top + (rect.height - shownH) / 2;
  return { x: clamp((clientX - left) / shownW), y: clamp((clientY - top) / shownH) };
}

/**
 * Tap to focus on a camera preview, as in a camera app (support ticket
 * 2026-10-10). Put `onPointerDown` on the element that holds the <video>
 * (position: relative) and render <CameraFocusRing ring={ring} /> inside it.
 * Only a plain tap on the picture counts: a tap on a button or on the
 * controls bar is left alone, as are a second finger and other mouse
 * buttons. The ring shows only where the camera took the point.
 */
export default function useTapToFocus(videoRef) {
  const [ring, setRing] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onPointerDown = useCallback((e) => {
    if (e.isPrimary === false || (typeof e.button === 'number' && e.button !== 0)) return;
    if (e.target?.closest?.('button, a, input, select, textarea, label, .camera-controls')) return;
    const video = videoRef.current;
    const stream = video?.srcObject;
    if (!video || !stream) return;
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
    if (e.clientX < rect.left || e.clientX > rect.left + rect.width
      || e.clientY < rect.top || e.clientY > rect.top + rect.height) return;
    const host = e.currentTarget.getBoundingClientRect();
    const { x, y } = framePoint(video, rect, e.clientX, e.clientY);
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
