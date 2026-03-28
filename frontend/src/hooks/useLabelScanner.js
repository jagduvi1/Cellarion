import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Custom hook that encapsulates label-scan camera logic.
 *
 * @param {Function} apiFetch  — authenticated fetch from useAuth()
 * @param {Object}   callbacks — optional callbacks for scan results
 * @param {Function} callbacks.onScanSuccess — called with scan data when label is read successfully
 * @param {Function} callbacks.onScanError   — called with error message on failure
 *
 * @returns {{ labelCam, labelScanning, labelFacing, setLabelFacing,
 *             labelVideoRef, labelCanvasRef,
 *             startCamera, stopCamera, capturePhoto }}
 */
export default function useLabelScanner(apiFetch, { onScanSuccess, onScanError } = {}) {
  const [labelCam, setLabelCam] = useState({ open: false, error: null });
  const [labelScanning, setLabelScanning] = useState(false);
  const [labelFacing, setLabelFacing] = useState('environment');
  const labelVideoRef = useRef(null);
  const labelCanvasRef = useRef(null);
  const labelStreamRef = useRef(null);

  // Keep callbacks in refs so they don't trigger re-creation of capturePhoto
  const onSuccessRef = useRef(onScanSuccess);
  const onErrorRef = useRef(onScanError);
  onSuccessRef.current = onScanSuccess;
  onErrorRef.current = onScanError;

  const stopCamera = useCallback(() => {
    if (labelStreamRef.current) {
      labelStreamRef.current.getTracks().forEach(t => t.stop());
      labelStreamRef.current = null;
    }
    setLabelCam({ open: false, error: null });
  }, []);

  const startCamera = useCallback(async () => {
    setLabelCam({ open: true, error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: labelFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      labelStreamRef.current = stream;
      requestAnimationFrame(() => {
        if (labelVideoRef.current) labelVideoRef.current.srcObject = stream;
      });
    } catch (err) {
      let msg = 'Could not access camera.';
      if (err.name === 'NotAllowedError') msg = 'Camera access denied. Please allow camera permissions.';
      else if (err.name === 'NotFoundError') msg = 'No camera found on this device.';
      setLabelCam({ open: true, error: msg });
    }
  }, [labelFacing]);

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
        setLabelCam({ open: true, error: 'Capture failed. Please try again.' });
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

        const res = await apiFetch('/api/wines/scan-label', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64, mediaType: 'image/jpeg' })
        });
        const data = await res.json();

        if (res.ok && data.extracted) {
          stopCamera();
          if (onSuccessRef.current) onSuccessRef.current(data);
        } else {
          stopCamera();
          if (onErrorRef.current) onErrorRef.current(data.error || 'Could not read label. Try again.');
        }
      } catch {
        stopCamera();
        if (onErrorRef.current) onErrorRef.current('Scan failed. Please try again.');
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
    stopCamera,
    capturePhoto
  };
}
