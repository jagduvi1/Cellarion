import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import AuthImage from './AuthImage';
import { API_URL } from '../api/apiConstants';
import './ImageUpload.css';

function ImageUpload({ bottleId, wineDefinitionId, credit, onUploadComplete, onProcessingComplete }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [images, setImages] = useState([]);
  const [error, setError] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [facingMode, setFacingMode] = useState('environment');
  // "Keep the background": skip background removal for this upload. rembg
  // expects a whole bottle; on a photo of just the label, or a product shot,
  // it keeps whatever figure it finds on the label and cuts the rest away
  // (support ticket 6a97f870, 2026-09-02).
  const [keepBackground, setKeepBackground] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);
  const pollTimers = useRef({});

  // Poll for processing result
  const pollImage = useCallback((imageId) => {
    let attempts = 0;
    const maxAttempts = 60;

    const poll = async () => {
      attempts++;
      try {
        const res = await apiFetch(`/api/images/${imageId}`);
        if (res.ok) {
          const data = await res.json();
          const img = data.image;
          if (img.status === 'processed' || img.status === 'approved') {
            setImages(prev => prev.map(p =>
              p.id === imageId
                ? { ...p, processedSrc: img.processedUrl, status: 'processed' }
                : p
            ));
            if (onProcessingComplete && img.processedUrl) {
              const url = img.processedUrl.startsWith('http')
                ? img.processedUrl
                : `${API_URL}${img.processedUrl}`;
              onProcessingComplete(url);
            }
            delete pollTimers.current[imageId];
            return;
          }
          if (img.status === 'uploaded' && attempts > 3) {
            setImages(prev => prev.map(p =>
              p.id === imageId ? { ...p, status: 'failed' } : p
            ));
            delete pollTimers.current[imageId];
            return;
          }
        } else if (res.status < 500) {
          // 4xx: image deleted/rejected or auth lost — stop polling and show
          // the failed state (with its retry button) instead of an endless
          // "Removing background…" spinner. 5xx falls through to reschedule.
          setImages(prev => prev.map(p =>
            p.id === imageId ? { ...p, status: 'failed' } : p
          ));
          delete pollTimers.current[imageId];
          return;
        }
      } catch (err) {
        // Network error, keep trying
      }

      if (attempts < maxAttempts) {
        pollTimers.current[imageId] = setTimeout(poll, 2000);
      } else {
        setImages(prev => prev.map(p =>
          p.id === imageId ? { ...p, status: 'failed' } : p
        ));
        delete pollTimers.current[imageId];
      }
    };

    pollTimers.current[imageId] = setTimeout(poll, 2000);
  }, [apiFetch]);

  useEffect(() => {
    return () => { Object.values(pollTimers.current).forEach(clearTimeout); };
  }, []);

  const uploadFile = async (file) => {
    if (!file) return;

    const localSrc = URL.createObjectURL(file);
    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append('image', file);
    if (bottleId) formData.append('bottleId', bottleId);
    if (wineDefinitionId) formData.append('wineDefinitionId', wineDefinitionId);
    if (credit && credit.trim()) formData.append('credit', credit.trim());
    if (keepBackground) formData.append('keepBackground', '1');

    try {
      const res = await apiFetch('/api/images/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        // With the background kept there is no job to wait for: the server
        // answers 'processed' straight away with the original as the kept
        // image, so show it and hand it to the parent now instead of polling.
        const done = data.image.status === 'processed' && data.image.processedUrl;
        const newImage = done
          ? { id: data.image._id, originalSrc: localSrc, processedSrc: data.image.processedUrl, status: 'processed' }
          : { id: data.image._id, originalSrc: localSrc, processedSrc: null, status: 'processing' };
        setImages(prev => [...prev, newImage]);
        if (onUploadComplete) onUploadComplete(data.image);
        if (done) {
          if (onProcessingComplete) {
            onProcessingComplete(data.image.processedUrl.startsWith('http') ? data.image.processedUrl : `${API_URL}${data.image.processedUrl}`);
          }
        } else {
          pollImage(data.image._id);
        }
      } else {
        setError(data.error || t('imageUpload.uploadFailed'));
        URL.revokeObjectURL(localSrc);
      }
    } catch (err) {
      setError(t('imageUpload.networkError'));
      URL.revokeObjectURL(localSrc);
    } finally {
      setUploading(false);
    }
  };

  // --- Image management ---

  const removeImage = (imageId) => {
    if (pollTimers.current[imageId]) {
      clearTimeout(pollTimers.current[imageId]);
      delete pollTimers.current[imageId];
    }
    setImages(prev => {
      const removed = prev.find(p => p.id === imageId);
      if (removed?.originalSrc) URL.revokeObjectURL(removed.originalSrc);
      return prev.filter(p => p.id !== imageId);
    });
  };

  const retryImage = async (imageId) => {
    setImages(prev => prev.map(p =>
      p.id === imageId ? { ...p, status: 'processing' } : p
    ));
    try {
      await apiFetch(`/api/images/${imageId}/retry`, { method: 'POST' });
      pollImage(imageId);
    } catch (err) {
      setImages(prev => prev.map(p =>
        p.id === imageId ? { ...p, status: 'failed' } : p
      ));
    }
  };

  // --- Camera logic ---

  // Mirrors cameraOpen for the getUserMedia race check below — the promise
  // may resolve after the user has already closed the viewfinder.
  const cameraOpenRef = useRef(false);

  const stopCamera = useCallback(() => {
    cameraOpenRef.current = false;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
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
      if (err.name === 'NotAllowedError') {
        setCameraError(t('camera.accessDenied'));
      } else if (err.name === 'NotFoundError') {
        setCameraError(t('camera.notFound'));
      } else {
        setCameraError(t('camera.accessErrorDetail', { message: err.message }));
      }
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

  useEffect(() => {
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropW = Math.min(Math.round(vw * 0.95), vw);
    const cropH = Math.min(Math.round(vh * 0.98), vh);
    const cropX = Math.round((vw - cropW) / 2);
    const cropY = Math.round((vh - cropH) / 2);

    canvas.width = cropW;
    canvas.height = cropH;
    canvas.getContext('2d').drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    canvas.toBlob((blob) => {
      if (blob) {
        stopCamera();
        uploadFile(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      }
    }, 'image/jpeg', 0.92);
  }, [stopCamera, uploadFile]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="image-upload">
      {/* Camera viewfinder modal */}
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

      {/* Upload buttons */}
      <div className="upload-buttons">
        <button type="button" className="btn btn-upload" onClick={startCamera} disabled={uploading || cameraOpen}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          {t('camera.takePhotoButton')}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          onChange={(e) => { Array.from(e.target.files).forEach(uploadFile); e.target.value = ''; }}
          style={{ display: 'none' }}
        />
        <button type="button" className="btn btn-upload btn-upload-secondary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          {t('imageUpload.upload')}
        </button>
      </div>

      <label className="upload-option">
        <input
          type="checkbox"
          checked={keepBackground}
          onChange={(e) => setKeepBackground(e.target.checked)}
          disabled={uploading}
        />
        <span className="upload-option-text">
          {t('imageUpload.keepBackground')}
          <small className="upload-option-hint">{t('imageUpload.keepBackgroundHint')}</small>
        </span>
      </label>

      {uploading && <p className="upload-status">{t('imageUpload.uploading')}</p>}
      {error && <div className="upload-error">{error}</div>}

      {images.length > 0 && (
        <div className="upload-previews">
          {images.map((img) => (
            <div key={img.id} className="preview-card">
              <div className="preview-image-wrap">
                {img.status === 'processed' && img.processedSrc ? (
                  <AuthImage
                    src={img.processedSrc.startsWith('http') ? img.processedSrc : `${API_URL}${img.processedSrc}`}
                    alt={t('imageUpload.processedAlt')}
                    className="preview-img"
                  />
                ) : (
                  <img
                    src={img.originalSrc}
                    alt={t('imageUpload.originalAlt')}
                    className={`preview-img ${img.status === 'processing' ? 'preview-img-dimmed' : ''}`}
                  />
                )}
                {img.status === 'processing' && (
                  <div className="preview-overlay">
                    <div className="spinner"></div>
                    <span>{t('imageUpload.removingBackground')}</span>
                  </div>
                )}
                {img.status === 'failed' && (
                  <div className="preview-overlay preview-overlay-failed">
                    <span>{t('imageUpload.processingFailed')}</span>
                    <button type="button" className="btn-retry" onClick={() => retryImage(img.id)}>{t('imageUpload.retry')}</button>
                  </div>
                )}
              </div>
              <div className="preview-footer">
                {img.status === 'processed' && <span className="preview-badge-ok">{t('imageUpload.ready')}</span>}
                {img.status === 'processing' && <span className="preview-badge-processing">{t('imageUpload.processing')}</span>}
                {img.status === 'failed' && <span className="preview-badge-failed">{t('imageUpload.failed')}</span>}
                <button type="button" className="btn-remove" onClick={() => removeImage(img.id)} aria-label={t('imageUpload.removeThisImage')}>✕ {t('imageUpload.remove')}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ImageUpload;
