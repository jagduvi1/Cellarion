/**
 * The phone camera for close work — a label, a barcode (support ticket
 * 2026-10-10: on a Samsung the preview never came into focus, so a barcode
 * could not be read, while the phone's own camera app focused fine).
 *
 * A browser opens the camera with whatever focus it defaults to. Where the
 * camera reports its focus modes (Chrome on Android), three things help:
 *   - continuous autofocus is switched on, as a camera app does;
 *   - a rear lens that cannot autofocus at all (some phones hand the browser
 *     a fixed-focus wide lens first) is swapped for one that can, and the
 *     choice is remembered on this device so the next opening goes straight
 *     to it;
 *   - focusAt() focuses on a tapped point, then goes back to continuous.
 * Where the camera reports nothing (iPhone, Firefox), the camera opens as
 * before and the browser's own focus handles it.
 */

const LENS_KEY = 'cellarion.autofocusCamera';

const media = () => navigator.mediaDevices;
const videoTrack = (stream) => stream?.getVideoTracks?.()[0] || null;
const stopStream = (stream) => stream?.getTracks?.().forEach((t) => t.stop());

function focusModes(stream) {
  const caps = videoTrack(stream)?.getCapabilities?.();
  return caps && Array.isArray(caps.focusMode) ? caps.focusMode : null;
}

/** True when the camera says which focus modes it has (so a fixed-focus lens can be told apart). */
export function reportsFocus(stream) {
  const modes = focusModes(stream);
  return !!modes && modes.length > 0;
}

/** True when the camera can keep itself in focus. */
export function canAutofocus(stream) {
  return (focusModes(stream) || []).includes('continuous');
}

function rememberedLens() {
  try { return window.localStorage.getItem(LENS_KEY) || null; } catch { return null; }
}
function rememberLens(id) {
  try { if (id) window.localStorage.setItem(LENS_KEY, id); else window.localStorage.removeItem(LENS_KEY); } catch { /* storage off */ }
}

/** Switch on continuous autofocus where the camera offers it. */
export async function keepInFocus(stream) {
  const track = videoTrack(stream);
  if (!track?.applyConstraints || !canAutofocus(stream)) return false;
  try {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    return true;
  } catch {
    return false;
  }
}

// The current lens cannot autofocus: try the other rear lenses, one at a
// time (a phone may refuse two open cameras), and keep the first that can.
async function findAutofocusLens(currentId, size) {
  let devices = [];
  try { devices = await media().enumerateDevices(); } catch { return null; }
  const others = devices.filter((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== currentId
    && !/front|user|selfie/i.test(d.label || ''));
  for (const d of others) {
    let s;
    try {
      s = await media().getUserMedia({ video: { deviceId: { exact: d.deviceId }, ...size }, audio: false });
    } catch {
      continue;
    }
    const facing = videoTrack(s)?.getSettings?.().facingMode;
    if ((!facing || facing === 'environment') && canAutofocus(s)) return { stream: s, deviceId: d.deviceId };
    stopStream(s);
  }
  return null;
}

/**
 * Open the camera — the rear one by default — for a label or a barcode, in
 * focus where the device allows it. Same errors as getUserMedia
 * (NotAllowedError, NotFoundError, …), so callers keep their own messages.
 */
export async function openCamera({ facingMode = 'environment', width = 1920, height = 1080 } = {}) {
  const size = { width: { ideal: width }, height: { ideal: height } };
  const rear = facingMode === 'environment';
  let stream = null;

  // The rear lens this device was found to focus with.
  const remembered = rear ? rememberedLens() : null;
  if (remembered) {
    try {
      stream = await media().getUserMedia({ video: { deviceId: { exact: remembered }, ...size }, audio: false });
    } catch (err) {
      if (err?.name === 'NotAllowedError') throw err;
      rememberLens(null); // gone (another phone, a reset) — choose again
    }
  }
  if (!stream) stream = await media().getUserMedia({ video: { facingMode, ...size }, audio: false });

  // A rear lens that reports its focus modes but has no autofocus: look for
  // one that has. Only where focus modes are reported at all, so a browser
  // that says nothing never cycles through the cameras.
  if (rear && !remembered && reportsFocus(stream) && !canAutofocus(stream)) {
    const currentId = videoTrack(stream)?.getSettings?.().deviceId || null;
    stopStream(stream);
    const better = await findAutofocusLens(currentId, size);
    if (better) {
      stream = better.stream;
      rememberLens(better.deviceId);
    } else {
      stream = await media().getUserMedia({ video: { facingMode, ...size }, audio: false });
    }
  }

  await keepInFocus(stream);
  return stream;
}

/**
 * Focus on one point of the picture (x, y from 0 to 1 across the preview),
 * as tapping does in a camera app; back to continuous focus a moment later.
 * False when the camera cannot be told where to focus.
 */
export async function focusAt(stream, x, y) {
  const track = videoTrack(stream);
  if (!track?.applyConstraints) return false;
  const modes = focusModes(stream) || [];
  const pointable = !!media()?.getSupportedConstraints?.().pointsOfInterest;
  if (!pointable && !modes.includes('single-shot')) return false;
  const point = pointable ? { pointsOfInterest: [{ x, y }] } : {};
  try {
    await track.applyConstraints({ advanced: [{ ...point, ...(modes.includes('single-shot') ? { focusMode: 'single-shot' } : {}) }] });
  } catch {
    return false;
  }
  if (modes.includes('continuous')) {
    setTimeout(() => {
      if (track.readyState !== 'live') return;
      track.applyConstraints({ advanced: [{ ...point, focusMode: 'continuous' }] }).catch(() => {});
    }, 2500);
  }
  return true;
}
