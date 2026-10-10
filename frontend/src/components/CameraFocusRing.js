import './CameraFocusRing.css';

/** The ring where a tap set the focus (hooks/useTapToFocus). */
export default function CameraFocusRing({ ring }) {
  if (!ring) return null;
  return <span key={ring.key} className="camera-focus-ring" style={{ left: ring.left, top: ring.top }} aria-hidden="true" />;
}
