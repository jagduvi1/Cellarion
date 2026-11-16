import { useState, useRef, useCallback, useEffect } from 'react';
import i18n from '../i18n';
import { scanLabel, scanLabelBack } from '../api/wines';
import { track } from '../utils/track';
import { openCamera, isSuperseded } from '../utils/camera';
import { messageForResponse } from '../utils/friendlyError';

// Every scan is sent at most 800 px on its longer edge, to keep the API cost low.
const MAX_DIM = 800;

// Draw `source` (a video frame or a loaded photo) into `canvas`, scaled down
// to MAX_DIM on its longer edge.
function drawScaled(canvas, source, width, height) {
  let w = width;
  let h = height;
  if (w > MAX_DIM || h > MAX_DIM) {
    if (w >= h) { h = Math.round((h / w) * MAX_DIM); w = MAX_DIM; }
    else { w = Math.round((w / h) * MAX_DIM); h = MAX_DIM; }
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // White under the picture: a cut-out bottle (a shop's transparent PNG or
  // WebP) would otherwise be read on the black a JPEG gives transparent pixels.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
}

// A photo the user picked, decoded into an <img> the canvas can draw.
function loadPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('photo could not be read')); };
    img.src = url;
  });
}

/**
 * Custom hook that encapsulates label-scan camera logic.
 *
 * It drives TWO scans through one viewfinder: the ordinary FRONT label scan,
 * and the optional BACK-label rescue a page offers when the front result came
 * back incomplete. Same camera, same capture pipeline, same 800px JPEG — only
 * the endpoint and the callback differ, so the mode is a ref set by
 * startBackCamera rather than a second copy of all of this.
 *
 * @param {Function} apiFetch  — authenticated fetch from useAuth()
 * @param {Object}   callbacks — optional callbacks for scan results
 * @param {Function} callbacks.onScanSuccess — called with scan data when label is read successfully
 * @param {Function} callbacks.onScanError   — called with (message, responseBody) on failure.
 *   The body matters: a 422 now carries `scanImageId`, so a page that falls
 *   back to manual entry can still supply the photo to the pending wine.
 * @param {Function} callbacks.onBackScanSuccess — called with the back-scan
 *   response ({ merged, conflicts, filled, match, backScanImageId })
 *
 * A photo chosen from the device (scanFile) goes through the same pipeline as
 * a camera capture: the viewfinder opens only to show "reading the label", and
 * the result arrives through the same callbacks. It is always a FRONT scan.
 *
 * @returns {{ labelCam, labelScanning, labelFacing, setLabelFacing,
 *             labelVideoRef, labelCanvasRef,
 *             startCamera, startBackCamera, stopCamera, capturePhoto, scanFile }}
 */
export default function useLabelScanner(apiFetch, { onScanSuccess, onScanError, onBackScanSuccess } = {}) {
  const [labelCam, setLabelCam] = useState({ open: false, error: null });
  const [labelScanning, setLabelScanning] = useState(false);
  const [labelFacing, setLabelFacing] = useState('environment');
  const labelVideoRef = useRef(null);
  const labelCanvasRef = useRef(null);
  const labelStreamRef = useRef(null);

  // Keep callbacks in refs so they don't trigger re-creation of capturePhoto
  const onSuccessRef = useRef(onScanSuccess);
  const onErrorRef = useRef(onScanError);
  const onBackSuccessRef = useRef(onBackScanSuccess);
  onSuccessRef.current = onScanSuccess;
  onErrorRef.current = onScanError;
  onBackSuccessRef.current = onBackScanSuccess;

  // Which label the next capture is of. A ref, not state: capturePhoto is
  // memoised and must read the CURRENT mode, and a re-render between "start the
  // back camera" and "shutter" would be a way to scan the back label into the
  // front endpoint.
  const modeRef = useRef('front');
  // Context for a back scan: what the front pass produced, plus the id of the
  // stored front frame. Set by startBackCamera.
  const backContextRef = useRef(null);
  // The raw base64 of the last FRONT capture, kept so the back scan can send
  // both faces to the model. Held here rather than in the page because the page
  // only ever sees the background-removed render, which is the wrong image to
  // ask a model to read.
  const lastFrontFrameRef = useRef(null);

  // Mirrors PhotoCapture/ImageUpload's cameraOpenRef guard: getUserMedia can
  // resolve AFTER the user dismissed the viewfinder (the permission prompt
  // was up) — without the check the just-acquired stream is stored but never
  // stopped and the camera light stays on until page unload.
  const camOpenRef = useRef(false);

  // Which scan is current. A scan's answer reaches the page only while it is
  // still the latest one: a viewfinder dismissed mid-read (stopCamera) or a
  // second photo chosen meanwhile makes the earlier answer stale, so it can
  // neither overwrite the newer result nor close what is showing now.
  const scanSeqRef = useRef(0);

  // Close the viewfinder the way a finished scan does; the scan stays current.
  const closeViewfinder = useCallback(() => {
    camOpenRef.current = false;
    // Back to the ordinary front scan: the next time the viewfinder opens it is
    // for a new bottle unless a page explicitly asks for the rescue again.
    modeRef.current = 'front';
    if (labelStreamRef.current) {
      labelStreamRef.current.getTracks().forEach(t => t.stop());
      labelStreamRef.current = null;
    }
    setLabelCam({ open: false, error: null });
  }, []);

  // The person closing the viewfinder: a read still under way is dropped.
  const stopCamera = useCallback(() => {
    scanSeqRef.current += 1;
    setLabelScanning(false);
    closeViewfinder();
  }, [closeViewfinder]);

  const startCamera = useCallback(async () => {
    setLabelCam({ open: true, error: null });
    camOpenRef.current = true;
    try {
      // In focus where the phone allows it — a label and a barcode are read
      // up close (utils/camera).
      const stream = await openCamera({ facingMode: labelFacing, width: 1280, height: 720 });
      if (!camOpenRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      // Replace (never leak) a previous stream, e.g. after a camera switch.
      if (labelStreamRef.current) labelStreamRef.current.getTracks().forEach(t => t.stop());
      labelStreamRef.current = stream;
      requestAnimationFrame(() => {
        if (labelVideoRef.current) labelVideoRef.current.srcObject = stream;
      });
    } catch (err) {
      // A newer open (a quick camera switch) took over: nothing to show.
      if (isSuperseded(err)) return;
      let msg = i18n.t('camera.accessError');
      if (err.name === 'NotAllowedError') msg = i18n.t('camera.accessDenied');
      else if (err.name === 'NotFoundError') msg = i18n.t('camera.notFound');
      setLabelCam({ open: true, error: msg });
    }
  }, [labelFacing]);

  /**
   * Open the viewfinder for the OPTIONAL back-label rescue.
   *
   * Never reached unless a page decided the front result was incomplete —
   * skipping it has to behave exactly like today, so nothing here changes the
   * front flow's state.
   *
   * @param {{frontExtracted?: object, frontScanImageId?: string|null}} context
   */
  const startBackCamera = useCallback((context = {}) => {
    modeRef.current = 'back';
    backContextRef.current = context;
    startCamera();
  }, [startCamera]);

  // Restart camera when facing mode changes while camera is open
  useEffect(() => {
    if (labelCam.open && !labelCam.error) {
      if (labelStreamRef.current) labelStreamRef.current.getTracks().forEach(t => t.stop());
      startCamera();
    }
  }, [labelFacing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop camera on unmount
  useEffect(() => {
    return () => {
      if (labelStreamRef.current) labelStreamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  // Send a drawn canvas to the scan endpoint for the current mode; shared by
  // the camera shutter and a chosen photo.
  const scanCanvas = useCallback((canvas) => {
    const seq = ++scanSeqRef.current;
    const current = () => seq === scanSeqRef.current;
    setLabelScanning(true);
    canvas.toBlob(async (blob) => {
      if (!current()) return;
      if (!blob) {
        setLabelCam({ open: true, error: i18n.t('camera.captureFailed') });
        setLabelScanning(false);
        return;
      }
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });

        if (modeRef.current === 'back') {
          const ctx = backContextRef.current || {};
          const res = await scanLabelBack(apiFetch, {
            image: base64,
            // The FRONT frame as captured, not the background-removed render.
            // Omitted entirely when this session started from a 422 the user
            // walked away from — the back label alone is still a useful read.
            ...(lastFrontFrameRef.current ? { frontImage: lastFrontFrameRef.current } : {}),
            frontExtracted: ctx.frontExtracted || {},
            ...(ctx.frontScanImageId ? { frontScanImageId: ctx.frontScanImageId } : {}),
          });
          const data = await res.json();
          if (!current()) return;
          closeViewfinder();
          if (res.ok && data.merged) {
            if (onBackSuccessRef.current) onBackSuccessRef.current(data);
          } else if (onErrorRef.current) {
            onErrorRef.current(messageForResponse(res, data, i18n.t('camera.backLabelUnreadable'), i18n.t), data);
          }
          return;
        }

        // A front capture: remember the frame so an optional back scan can send
        // both faces.
        lastFrontFrameRef.current = base64;

        const res = await scanLabel(apiFetch, base64, 'image/jpeg');
        const data = await res.json();
        track('label-scan', { result: res.ok && data.extracted ? 'read' : 'unreadable' });
        if (!current()) return;

        if (res.ok && data.extracted) {
          closeViewfinder();
          if (onSuccessRef.current) onSuccessRef.current(data);
        } else {
          closeViewfinder();
          // The BODY rides along, not just the message: a 422 carries a
          // scanImageId, and dropping it is how an unreadable label used to
          // lose its photo (the pending wine then had no evidence at all).
          if (onErrorRef.current) onErrorRef.current(messageForResponse(res, data, i18n.t('camera.labelUnreadable'), i18n.t), data);
        }
      } catch {
        if (!current()) return;
        closeViewfinder();
        if (onErrorRef.current) onErrorRef.current(i18n.t('camera.scanFailed'), null);
      } finally {
        if (current()) setLabelScanning(false);
      }
    }, 'image/jpeg', 0.55);
  }, [apiFetch, closeViewfinder]);

  const capturePhoto = useCallback(() => {
    const video = labelVideoRef.current;
    const canvas = labelCanvasRef.current;
    if (!video || !canvas) return;
    drawScaled(canvas, video, video.videoWidth, video.videoHeight);

    // Stop the stream right after capture
    if (labelStreamRef.current) {
      labelStreamRef.current.getTracks().forEach(t => t.stop());
      labelStreamRef.current = null;
    }
    scanCanvas(canvas);
  }, [scanCanvas]);

  // Scan a label photo chosen from the device (a gallery picture or a shop
  // screenshot) instead of the camera.
  const scanFile = useCallback(async (file) => {
    if (!file) return;
    modeRef.current = 'front';
    const seq = ++scanSeqRef.current;
    setLabelScanning(true);
    setLabelCam({ open: true, error: null });
    const unreadable = () => {
      setLabelScanning(false);
      setLabelCam({ open: true, error: i18n.t('camera.photoUnreadable') });
    };
    let photo;
    try {
      photo = await loadPhoto(file);
    } catch {
      if (seq === scanSeqRef.current) unreadable();
      return;
    }
    // Dismissed, or another photo chosen, while this one was decoding.
    if (seq !== scanSeqRef.current) return;
    const canvas = document.createElement('canvas');
    try {
      // Throws when the browser cannot give a canvas (a phone's canvas memory
      // limit) or cannot draw the decoded picture: say so, never hang on
      // "reading the label".
      drawScaled(canvas, photo, photo.naturalWidth, photo.naturalHeight);
    } catch {
      unreadable();
      return;
    }
    scanCanvas(canvas);
  }, [scanCanvas]);

  return {
    labelCam,
    labelScanning,
    labelFacing,
    setLabelFacing,
    labelVideoRef,
    labelCanvasRef,
    startCamera,
    startBackCamera,
    stopCamera,
    capturePhoto,
    scanFile
  };
}
