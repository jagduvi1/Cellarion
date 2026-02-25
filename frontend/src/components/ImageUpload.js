import { useState, useRef, useCallback, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './ImageUpload.css';

function ImageUpload({ bottleId, wineDefinitionId, onUploadComplete }) {
  const { token } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [images, setImages] = useState([]); // { id, originalSrc, processedSrc, status }
  const [error, setError] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [facingMode, setFacingMode] = useState('environment');
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
        const res = await fetch(`/api/images/${imageId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) return;

        const img = data.image;
        if (img.status === 'processed' || img.status === 'approved') {
          setImages(prev => prev.map(p =>
            p.id === imageId
              ? { ...p, processedSrc: img.processedUrl, status: 'processed' }
              : p
          ));
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
  }, [token]);

  // Cleanup poll timers on unmount
  useEffect(() => {
    return () => {
      Object.values(pollTimers.current).forEach(clearTimeout);
    };
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

    try {
      const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      if (res.ok) {
        const newImage = {
          id: data.image._id,
          originalSrc: localSrc,
          processedSrc: null,
          status: 'processing'
        };
        setImages(prev => [...prev, newImage]);
        if (onUploadComplete) onUploadComplete(data.image);
        pollImage(data.image._id);
      } else {
        setError(data.error || 'Upload failed');
        URL.revokeObjectURL(localSrc);
      }
    } catch (err) {
      setError('Network error during upload');
      URL.revokeObjectURL(localSrc);
    } finally {
      setUploading(false);
    }
  };

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
      await fetch(`/api/images/${imageId}/retry`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      pollImage(imageId);
    } catch (err) {
      setImages(prev => prev.map(p =>
        p.id === imageId ? { ...p, status: 'failed' } : p
      ));
    }
  };

  // --- Camera logic ---

  const stopCamera = useCallback(() => {
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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      streamRef.current = stream;

      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      });
    } catch (err) {
      console.error('Camera access error:', err);
      if (err.name === 'NotAllowedError') {
        setCameraError('Camera access denied. Please allow camera permissions.');
      } else if (err.name === 'NotFoundError') {
        setCameraError('No camera found on this device.');
      } else {
        setCameraError('Could not access camera: ' + err.message);
      }
    }
  }, [facingMode]);

  const switchCamera = useCallback(() => {
    const newMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(newMode);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
  }, [facingMode]);

  useEffect(() => {
    if (cameraOpen && !cameraError) {
      startCamera();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Crop to the bottle overlay region + 10% margin for safety
    // Overlay is 80% wide, 90% tall — add margin so nothing gets clipped
    const cropW = Math.min(Math.round(vw * 0.95), vw);
    const cropH = Math.min(Math.round(vh * 0.98), vh);
    const cropX = Math.round((vw - cropW) / 2);
    const cropY = Math.round((vh - cropH) / 2);

    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
        stopCamera();
        uploadFile(file);
      }
    }, 'image/jpeg', 0.92);
  }, [stopCamera]);

  return (
    <div className="image-upload">
      {/* Camera viewfinder modal */}
      {cameraOpen && (
        <div className="camera-modal">
          <div className="camera-container">
            {cameraError ? (
              <div className="camera-error-overlay">
                <p>{cameraError}</p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={stopCamera}
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="camera-video"
                />

                <div className="camera-overlay">
                  <img
                    src="/bottle-overlay.png"
                    alt=""
                    className="bottle-guide"
                  />
                  <p className="overlay-hint">Place bottle in the center</p>
                </div>

                <div className="camera-controls">
                  <button
                    type="button"
                    className="camera-btn camera-btn-close"
                    onClick={stopCamera}
                    title="Close"
                  >
                    ✕
                  </button>

                  <button
                    type="button"
                    className="camera-btn camera-btn-capture"
                    onClick={capturePhoto}
                    title="Take Photo"
                  >
                    <span className="capture-ring"></span>
                  </button>

                  <button
                    type="button"
                    className="camera-btn camera-btn-switch"
                    onClick={switchCamera}
                    title="Switch Camera"
                  >
                    ⟲
                  </button>
                </div>
              </>
            )}
          </div>

          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      )}

      {/* Upload buttons */}
      <div className="upload-buttons">
        <button
          type="button"
          className="btn btn-upload"
          onClick={startCamera}
          disabled={uploading || cameraOpen}
        >
          <span className="upload-icon">📷</span>
          Take Photo
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          onChange={(e) => {
            Array.from(e.target.files).forEach(uploadFile);
            e.target.value = '';
          }}
          style={{ display: 'none' }}
        />
        <button
          type="button"
          className="btn btn-upload btn-upload-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          <span className="upload-icon">📁</span>
          Choose File
        </button>
      </div>

      {uploading && <p className="upload-status">Uploading...</p>}
      {error && <div className="upload-error">{error}</div>}

      {/* Image previews with processing status */}
      {images.length > 0 && (
        <div className="upload-previews">
          {images.map((img) => (
            <div key={img.id} className="preview-card">
              <div className="preview-image-wrap">
                {img.status === 'processed' && img.processedSrc ? (
                  <img
                    src={img.processedSrc}
                    alt="Processed"
                    className="preview-img"
                  />
                ) : (
                  <img
                    src={img.originalSrc}
                    alt="Original"
                    className={`preview-img ${img.status === 'processing' ? 'preview-img-dimmed' : ''}`}
                  />
                )}

                {img.status === 'processing' && (
                  <div className="preview-overlay">
                    <div className="spinner"></div>
                    <span>Removing background...</span>
                  </div>
                )}

                {img.status === 'failed' && (
                  <div className="preview-overlay preview-overlay-failed">
                    <span>Processing failed</span>
                    <button
                      type="button"
                      className="btn-retry"
                      onClick={() => retryImage(img.id)}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>

              <div className="preview-footer">
                {img.status === 'processed' && (
                  <span className="preview-badge-ok">Ready</span>
                )}
                {img.status === 'processing' && (
                  <span className="preview-badge-processing">Processing</span>
                )}
                {img.status === 'failed' && (
                  <span className="preview-badge-failed">Failed</span>
                )}
                <button
                  type="button"
                  className="btn-remove"
                  onClick={() => removeImage(img.id)}
                  title="Remove this image"
                >
                  ✕ Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ImageUpload;
