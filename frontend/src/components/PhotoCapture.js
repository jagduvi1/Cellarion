import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './ImageUpload.css'; // reuse camera + button styles

/**
 * PhotoCapture — camera modal + file picker, no upload.
 * Calls onCapture(file) with the selected File.
 * Manages its own preview state internally so no URL string
 * ever flows in from outside (avoids js/xss-through-dom taint path).
 */
function PhotoCapture({ onCapture, onRemove, processedUrl, processing }) {
  const { t } = useTranslation();
  const [capturedFile, setCapturedFile] = useState(null);
  const [capturedUrl, setCapturedUrl] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [facingMode, setFacingMode] = useState('environment');
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  // Create / revoke the preview blob URL whenever the captured file changes
  useEffect(() => {
    if (!capturedFile) { setCapturedUrl(''); return; }
    const url = URL.createObjectURL(capturedFile);
    setCapturedUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [capturedFile]);

  useEffect(() => {
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  // --- Camera ---

  // Mirrors cameraOpen for the getUserMedia race check below — the promise
  // may resolve after the user has already closed the viewfinder.
  const cameraOpenRef = useRef(false);

  const stopCamera = useCallback(() => {
    cameraOpenRef.current = false;
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
    cameraOpenRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      // The viewfinder may have been closed while the permission prompt was
      // up — stop the just-acquired stream or the camera stays on forever.
      if (!cameraOpenRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      // Replace (never leak) a previous stream, e.g. after a camera switch.
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = stream;
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') setCameraError(t('camera.accessDenied'));
      else if (err.name === 'NotFoundError') setCameraError(t('camera.notFound'));
      else setCameraError(t('camera.accessError'));
    }
  }, [facingMode, t]);

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
        const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
        setCapturedFile(file);
        onCapture(file);
      }
    }, 'image/jpeg', 0.92);
  }, [stopCamera, onCapture]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileChange = useCallback((e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setCapturedFile(file);
    onCapture(file);
  }, [onCapture]);

  const handleRemove = useCallback(() => {
    setCapturedFile(null);
    onRemove?.();
  }, [onRemove]);

  return (
    <>
      {cameraOpen && (
        <div className="camera-modal">
          <div className="camera-container">
            {cameraError ? (
              <div className="camera-error-overlay">
                <p>{cameraError}</p>
                <button type="button" className="btn btn-secondary" onClick={stopCamera}>{t('common.close')}</button>
              </div>
            ) : (
              <>
                <video ref={videoRef} autoPlay playsInline muted className="camera-video" />
                <div className="camera-overlay">
                  <img src="/bottle-overlay.png" alt="" className="bottle-guide" aria-hidden="true" />
                  <p className="overlay-hint">{t('camera.placeBottle')}</p>
                </div>
                <div className="camera-controls">
                  <button type="button" className="camera-btn camera-btn-close" onClick={stopCamera} aria-label={t('camera.closeCamera')}>✕</button>
                  <button type="button" className="camera-btn camera-btn-capture" onClick={capturePhoto} aria-label={t('camera.takePhoto')}>
                    <span className="capture-ring" aria-hidden="true"></span>
                  </button>
                  <button type="button" className="camera-btn camera-btn-switch" onClick={switchCamera} aria-label={t('camera.switchCamera')}>⟲</button>
                </div>
              </>
            )}
          </div>
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      )}

      {capturedFile ? (
        <div className="upload-preview-wrapper">
          {processedUrl ? (
            <img src={processedUrl} alt={t('photoCapture.previewAlt')} className="upload-preview" />
          ) : (
            capturedUrl && <img src={capturedUrl} alt={t('photoCapture.previewAlt')} className={`upload-preview${processing ? ' preview-img-dimmed' : ''}`} />
          )}
          {processing && (
            <div className="preview-overlay">
              <div className="spinner"></div>
              <span>{t('photoCapture.removingBackground')}</span>
            </div>
          )}
          <button type="button" className="btn-remove-image" onClick={handleRemove} aria-label={t('photoCapture.removeImage')}>×</button>
        </div>
      ) : (
        <div className="upload-buttons">
          <button type="button" className="btn btn-upload" onClick={startCamera} disabled={cameraOpen}>
            <span className="upload-icon" aria-hidden="true">📷</span>
            {t('camera.takePhotoButton')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <button type="button" className="btn btn-upload btn-upload-secondary" onClick={() => fileInputRef.current?.click()}>
            <span className="upload-icon" aria-hidden="true">📁</span>
            {t('photoCapture.chooseFile')}
          </button>
        </div>
      )}
    </>
  );
}

export default PhotoCapture;
