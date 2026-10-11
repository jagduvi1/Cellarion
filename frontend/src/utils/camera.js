/**
 * The phone camera for close work — a label, a barcode (support ticket
 * 2026-10-10: on some Android phones the preview never came into focus, so a
 * barcode could not be read, while the phone's own camera app focused fine).
 *
 * A browser opens the camera with whatever focus it defaults to. Where the
 * camera reports its focus modes (Chrome on Android), three things help:
 *   - continuous autofocus is switched on, as a camera app does;
 *   - a rear lens that cannot autofocus at all (some phones hand the browser
 *     a fixed-focus lens first) is swapped for one that can, and the outcome
 *     is remembered on this device — the lens, or that there is none better —
 *     so later openings are a single open;
 *   - focusAt() focuses on a tapped point, then goes back to continuous.
 * Where the camera reports nothing (iPhone, Firefox), the camera opens once,
 * as before, and the browser's own focus handles it.
 */

const LENS_KEY = 'cellarion.autofocusCamera';
// Searched once on this device: no rear lens focuses better than the default.
const NO_BETTER_LENS = 'default';

const media = () => (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
const videoTrack = (stream) => stream?.getVideoTracks?.()[0] || null;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Stop every track of a stream (the camera light goes off). */
export function stopStream(stream) {
  stream?.getTracks?.().forEach((t) => t.stop());
}

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

// A lens that can focus at all — continuously, or once when told (a tap).
function focusesAtAll(stream) {
  const modes = focusModes(stream) || [];
  return modes.includes('continuous') || modes.includes('single-shot');
}

function rememberedLens() {
  try { return window.localStorage.getItem(LENS_KEY) || null; } catch { return null; }
}
function rememberLens(value) {
  try {
    if (value) window.localStorage.setItem(LENS_KEY, value);
    else window.localStorage.removeItem(LENS_KEY);
  } catch { /* storage off: the search runs again next time */ }
}

// A camera that is busy for a moment — the phone has not released the lens
// just closed, or another app holds it — not one that is gone.
const BUSY = new Set(['NotReadableError', 'AbortError', 'TrackStartError']);
// A camera that is not there (any more): its id is forgotten.
const GONE = new Set(['OverconstrainedError', 'NotFoundError', 'ConstraintNotSatisfiedError', 'DevicesNotFoundError']);

// getUserMedia, once more after a short pause when the camera was busy:
// closing one lens and opening another back to back is exactly that case.
async function open(constraints) {
  try {
    return await media().getUserMedia(constraints);
  } catch (err) {
    if (!BUSY.has(err?.name)) throw err;
    await wait(400);
    return media().getUserMedia(constraints);
  }
}

// Try the other rear lenses one at a time (a phone may refuse two open
// cameras) and keep the first that autofocuses. `complete` is false when a
// lens could not be opened, so "none better" is not concluded from it.
async function findAutofocusLens(candidates, size) {
  let complete = true;
  for (const d of candidates) {
    let s;
    try {
      s = await open({ video: { deviceId: { exact: d.deviceId }, ...size }, audio: false });
    } catch {
      complete = false;
      continue;
    }
    const facing = videoTrack(s)?.getSettings?.().facingMode;
    if ((!facing || facing === 'environment') && canAutofocus(s)) return { stream: s, deviceId: d.deviceId, complete };
    stopStream(s);
  }
  return { stream: null, deviceId: null, complete };
}

// Only the newest request may deliver a camera: switching front and back
// quickly starts a second open while the first is still searching, and the
// first must not take the camera back when it finishes.
let openSeq = 0;
const SUPERSEDED = 'CameraSuperseded';
/** True for the error of an open that a newer one replaced — not a failure to show. */
export const isSuperseded = (err) => err?.name === SUPERSEDED;

/**
 * Open the camera — the rear one by default — for a label or a barcode, in
 * focus where the device allows it. Same errors as getUserMedia
 * (NotAllowedError, NotFoundError, …), so callers keep their own messages;
 * plus isSuperseded(err) when a newer openCamera() took over.
 */
export async function openCamera({ facingMode = 'environment', width = 1920, height = 1080 } = {}) {
  if (!media()?.getUserMedia) throw Object.assign(new Error('No camera available here'), { name: 'NotFoundError' });
  const seq = ++openSeq;
  const current = (stream) => {
    if (seq === openSeq) return stream;
    stopStream(stream);
    throw Object.assign(new Error('A newer camera request took over'), { name: SUPERSEDED });
  };
  const size = { width: { ideal: width }, height: { ideal: height } };
  const rear = facingMode === 'environment';
  const plain = () => open({ video: { facingMode, ...size }, audio: false });

  let stream = null;
  let searchable = rear;
  const remembered = rear ? rememberedLens() : null;
  if (remembered === NO_BETTER_LENS) searchable = false;
  else if (remembered) {
    searchable = false; // the remembered lens, or this time only the default
    try {
      const s = await open({ video: { deviceId: { exact: remembered }, ...size }, audio: false });
      // Still a rear lens that focuses (an update can renumber the cameras).
      const facing = videoTrack(s)?.getSettings?.().facingMode;
      if ((!facing || facing === 'environment') && canAutofocus(s)) stream = s;
      else { stopStream(s); rememberLens(null); searchable = true; }
    } catch (err) {
      if (err?.name === 'NotAllowedError') throw err;
      if (GONE.has(err?.name)) { rememberLens(null); searchable = true; }
      // Busy: kept for next time; this time the default lens.
    }
  }
  if (!stream) stream = current(await plain());

  // A rear lens that reports its focus modes but cannot focus at all: look
  // for one that can. Only where focus modes are reported, so a browser that
  // says nothing never cycles through the cameras. The list is read while
  // the camera is live, so the lenses carry their labels (front/back).
  if (searchable && reportsFocus(stream) && !focusesAtAll(stream)) {
    const currentId = videoTrack(stream)?.getSettings?.().deviceId || null;
    let devices = [];
    try { devices = await media().enumerateDevices(); } catch { devices = []; }
    const candidates = devices.filter((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== currentId
      && !/front|user|selfie/i.test(d.label || ''));
    if (candidates.length === 0) {
      rememberLens(NO_BETTER_LENS);
    } else {
      stopStream(stream);
      const found = await findAutofocusLens(candidates, size);
      if (found.stream) {
        stream = found.stream;
        rememberLens(found.deviceId);
      } else {
        if (found.complete) rememberLens(NO_BETTER_LENS);
        stream = await plain();
      }
      stream = current(stream);
    }
  }

  stream = current(stream);
  // Not awaited: the preview can start while the camera settles its focus.
  keepInFocus(stream);
  return stream;
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

// The pending "back to continuous" after a tap, per track: a new tap replaces
// it, so an earlier tap's timer never pulls focus back to its own point.
const backToContinuous = new WeakMap();

/**
 * Focus on one point of the picture (x, y from 0 to 1 across the camera
 * frame), as tapping does in a camera app; back to continuous focus a moment
 * later. False when this camera cannot focus there — a fixed-focus lens, or
 * a browser that reports no focus modes — so no ring is drawn for nothing.
 */
export async function focusAt(stream, x, y) {
  const track = videoTrack(stream);
  if (!track?.applyConstraints) return false;
  const modes = focusModes(stream) || [];
  const singleShot = modes.includes('single-shot');
  const continuous = modes.includes('continuous');
  // A browser lists pointsOfInterest whatever the camera: only a camera that
  // focuses at all is told where.
  if (!singleShot && !continuous) return false;
  const pointable = !!media()?.getSupportedConstraints?.().pointsOfInterest;
  if (!pointable && !singleShot) return false;
  const point = pointable ? { pointsOfInterest: [{ x, y }] } : {};
  clearTimeout(backToContinuous.get(track));
  try {
    await track.applyConstraints({ advanced: [{ ...point, ...(singleShot ? { focusMode: 'single-shot' } : {}) }] });
  } catch {
    return false;
  }
  if (singleShot && continuous) {
    backToContinuous.set(track, setTimeout(() => {
      if (track.readyState !== 'live') return;
      track.applyConstraints({ advanced: [{ ...point, focusMode: 'continuous' }] }).catch(() => {});
    }, 2500));
  }
  return true;
}
