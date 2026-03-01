import { useState, useRef, useCallback, useEffect } from 'react';
import './ImageUpload.css'; // reuse camera + button styles

/**
 * PhotoCapture — camera modal + crop, no upload.
 * Calls onCapture(file) with the final cropped File.
 * Shows a preview with a remove button once a file is chosen.
 */
// Only allow safe URL schemes to prevent javascript: URIs reaching img src
function sanitizeImageUrl(url) {
  if (!url) return '';
  if (url.startsWith('blob:') || url.startsWith('data:image/') ||
      url.startsWith('https://') || url.startsWith('http://') ||
      url.startsWith('/')) return url;
  return '';
}

function PhotoCapture({ onCapture, onRemove, preview }) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [facingMode, setFacingMode] = useState('environment');
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  // --- Camera ---

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
    setCameraError(null);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    setCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      streamRef.current = stream;
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') setCameraError('Camera access denied. Please allow camera permissions.');
      else if (err.name === 'NotFoundError') setCameraError('No camera found on this device.');
      else setCameraError('Could not access camera: ' + err.message);
    }
  }, [facingMode]);

  const switchCamera = useCallback(() => {
    const newMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(newMode);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
  }, [facingMode]);

  useEffect(() => {
    if (cameraOpen && !cameraError) startCamera();
  }, [facingMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropW = Math.min(Math.round(vw * 0.95), vw);
    const cropH = Math.min(Math.round(vh * 0.98), vh);
    canvas.width = cropW;
    canvas.height = cropH;
    canvas.getContext('2d').drawImage(
      video,
      Math.round((vw - cropW) / 2), Math.round((vh - cropH) / 2),
      cropW, cropH, 0, 0, cropW, cropH
    );
    canvas.toBlob((blob) => {
      if (blob) {
        stopCamera();
        onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      }
    }, 'image/jpeg', 0.92);
  }, [stopCamera, onCapture]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {cameraOpen && (
        <div className="camera-modal">
          <div className="camera-container">
            {cameraError ? (
              <div className="camera-error-overlay">
                <p>{cameraError}</p>
                <button type="button" className="btn btn-secondary" onClick={stopCamera}>Close</button>
              </div>
            ) : (
              <>
                <video ref={videoRef} autoPlay playsInline muted className="camera-video" />
                <div className="camera-overlay">
                  <img src="/bottle-overlay.png" alt="" className="bottle-guide" />
                  <p className="overlay-hint">Place bottle in the center</p>
                </div>
                <div className="camera-controls">
                  <button type="button" className="camera-btn camera-btn-close" onClick={stopCamera} title="Close">✕</button>
                  <button type="button" className="camera-btn camera-btn-capture" onClick={capturePhoto} title="Take Photo">
                    <span className="capture-ring"></span>
                  </button>
                  <button type="button" className="camera-btn camera-btn-switch" onClick={switchCamera} title="Switch Camera">⟲</button>
                </div>
              </>
            )}
          </div>
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      )}

      {preview ? (
        <div className="upload-preview-wrapper">
          <img src={sanitizeImageUrl(preview)} alt="Preview" className="upload-preview" />
          <button type="button" className="btn-remove-image" onClick={onRemove} aria-label="Remove image">×</button>
        </div>
      ) : (
        <div className="upload-buttons">
          <button type="button" className="btn btn-upload" onClick={startCamera} disabled={cameraOpen}>
            <span className="upload-icon">📷</span>
            Take Photo
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            onChange={(e) => { Array.from(e.target.files).forEach(f => onCapture(f)); e.target.value = ''; }}
            style={{ display: 'none' }}
          />
          <button type="button" className="btn btn-upload btn-upload-secondary" onClick={() => fileInputRef.current?.click()}>
            <span className="upload-icon">📁</span>
            Choose File
          </button>
        </div>
      )}
    </>
  );
}

export default PhotoCapture;
