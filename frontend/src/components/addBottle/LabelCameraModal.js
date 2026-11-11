import CameraFocusRing from '../CameraFocusRing';

/**
 * The camera view for scanning a label or a barcode: the live picture, the
 * capture button and the switch between the two cameras. The page owns the
 * camera (hooks/useLabelScanner) and what a capture leads to.
 */
export default function LabelCameraModal({
  labelCam, tapFocus, closeCamera, labelVideoRef, labelScanning, t, barcodeMode, barcodeNoted,
  captureLabelPhoto, setLabelFacing, labelCanvasRef,
}) {
  return (
    <>
      {labelCam.open && (
        <div className="camera-modal">
          <div className="camera-container" onPointerDown={tapFocus.onPointerDown}>
            {labelCam.error ? (
              <div className="camera-error-overlay">
                <p>{labelCam.error}</p>
                <button type="button" className="btn btn-secondary" onClick={closeCamera}>Close</button>
              </div>
            ) : (
              <>
                <video ref={labelVideoRef} autoPlay playsInline muted className="camera-video" />
                <CameraFocusRing ring={tapFocus.ring} />
                {labelScanning ? (
                  <div className="label-scan-overlay">
                    <div className="label-scan-spinner" />
                    <span>{t('addBottle.scanReading')}</span>
                  </div>
                ) : (
                  <>
                    <div className="camera-overlay">
                      <div className="label-guide-frame" />
                      <p className="overlay-hint">
                        {barcodeMode
                          ? t('addBottle.barcodeOnlyHint', 'Point the camera at the barcode — it is read automatically.')
                          : barcodeNoted
                            ? t('addBottle.barcodeNoted', 'New barcode — thank you! Now photograph the front label, and the barcode will be saved for the next person.')
                            : t('addBottle.scanHint')}
                      </p>
                    </div>
                    <div className="camera-controls">
                      <button type="button" className="camera-btn camera-btn-close" onClick={closeCamera} aria-label="Close camera">✕</button>
                      {/* No shutter in barcode-only mode: nothing is photographed. */}
                      {!barcodeMode && (
                        <button type="button" className="camera-btn camera-btn-capture" onClick={captureLabelPhoto} aria-label="Scan label">
                          <span className="capture-ring" aria-hidden="true"></span>
                        </button>
                      )}
                      <button type="button" className="camera-btn camera-btn-switch" onClick={() => setLabelFacing(f => f === 'environment' ? 'user' : 'environment')} aria-label="Switch camera">⟲</button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          <canvas ref={labelCanvasRef} style={{ display: 'none' }} />
        </div>
      )}
    </>
  );
}
