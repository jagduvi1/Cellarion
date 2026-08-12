import { useState, useRef, useCallback, useEffect } from 'react';
import i18n from '../i18n';
import { scanLabel, scanLabelBack } from '../api/wines';

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
 * @returns {{ labelCam, labelScanning, labelFacing, setLabelFacing,
 *             labelVideoRef, labelCanvasRef,
 *             startCamera, startBackCamera, stopCamera, capturePhoto }}
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

  const stopCamera = useCallback(() => {
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

  const startCamera = useCallback(async () => {
    setLabelCam({ open: true, error: null });
    camOpenRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: labelFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
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

  const capturePhoto = useCallback(async () => {
    const video = labelVideoRef.current;
    const canvas = labelCanvasRef.current;
    if (!video || !canvas) return;

    // Resize to max 800px to keep API cost low
    const MAX_DIM = 800;
    let vw = video.videoWidth;
    let vh = video.videoHeight;
    if (vw > MAX_DIM || vh > MAX_DIM) {
      if (vw >= vh) { vh = Math.round((vh / vw) * MAX_DIM); vw = MAX_DIM; }
      else { vw = Math.round((vw / vh) * MAX_DIM); vh = MAX_DIM; }
    }
    canvas.width = vw;
    canvas.height = vh;
    canvas.getContext('2d').drawImage(video, 0, 0, vw, vh);

    // Stop the stream right after capture
    if (labelStreamRef.current) {
      labelStreamRef.current.getTracks().forEach(t => t.stop());
      labelStreamRef.current = null;
    }
    setLabelScanning(true);

    canvas.toBlob(async (blob) => {
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
          stopCamera();
          if (res.ok && data.merged) {
            if (onBackSuccessRef.current) onBackSuccessRef.current(data);
          } else if (onErrorRef.current) {
            onErrorRef.current(data.error || 'Could not read the back label. Try again.', data);
          }
          return;
        }

        // A front capture: remember the frame so an optional back scan can send
        // both faces.
        lastFrontFrameRef.current = base64;

        const res = await scanLabel(apiFetch, base64, 'image/jpeg');
        const data = await res.json();

        if (res.ok && data.extracted) {
          stopCamera();
          if (onSuccessRef.current) onSuccessRef.current(data);
        } else {
          stopCamera();
          // The BODY rides along, not just the message: a 422 carries a
          // scanImageId, and dropping it is how an unreadable label used to
          // lose its photo (the pending wine then had no evidence at all).
          if (onErrorRef.current) onErrorRef.current(data.error || 'Could not read label. Try again.', data);
        }
      } catch {
        stopCamera();
        if (onErrorRef.current) onErrorRef.current('Scan failed. Please try again.', null);
      } finally {
        setLabelScanning(false);
      }
    }, 'image/jpeg', 0.55);
  }, [apiFetch, stopCamera]);

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
    capturePhoto
  };
}
