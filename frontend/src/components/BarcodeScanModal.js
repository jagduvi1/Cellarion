import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { updateBottle } from '../api/bottles';
import useBarcodeWatch from '../hooks/useBarcodeWatch';
import { normalizeBarcode } from '../utils/barcode';
import Modal from './Modal';
import './BarcodeScanModal.css';

/**
 * "Add barcode" for a bottle already in the cellar (the bottle page's ⋮).
 * Until now a barcode could only be read while adding a bottle. The camera
 * reads it with the same reader Add Bottle uses (useBarcodeWatch: the
 * browser's BarcodeDetector, else the ZXing fallback, the same code in two
 * frames); the numbers can also be typed. A code read by the camera is saved
 * at once; a typed one when the user presses Save. A bottle that has a
 * barcode can have it removed here.
 *
 * Saving goes through the ordinary bottle update (PUT /api/bottles/:id),
 * which stores the canonical form and refuses an invalid code.
 */
export default function BarcodeScanModal({ bottle, onClose, onSaved }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const inputId = useId();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const openRef = useRef(true);
  const [cameraError, setCameraError] = useState(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraOn(false);
  }, []);

  // The camera opens with the window and closes with it — once per opening,
  // whatever re-renders in between (the texts are read through a ref).
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    const t = (...args) => tRef.current(...args);
    openRef.current = true;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        // Closed while the permission prompt was up: never leave it running.
        if (!openRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setCameraOn(true);
      } catch (err) {
        if (err?.name === 'NotAllowedError') setCameraError(t('camera.accessDenied'));
        else if (err?.name === 'NotFoundError') setCameraError(t('camera.notFound'));
        else setCameraError(t('camera.accessError'));
      }
    })();
    return () => { openRef.current = false; stopCamera(); };
  }, [stopCamera]);

  const save = useCallback(async (code) => {
    setSaving(true);
    setError(null);
    try {
      const res = await updateBottle(apiFetch, bottle._id, { barcode: code });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('barcodeScan.failed', 'Could not save the barcode. Please try again.'));
        setSaving(false);
        return;
      }
      stopCamera();
      onSaved(data.bottle?.barcode ?? (code || null));
    } catch {
      setError(t('barcodeScan.failed', 'Could not save the barcode. Please try again.'));
      setSaving(false);
    }
  }, [apiFetch, bottle._id, onSaved, stopCamera, t]);

  useBarcodeWatch(videoRef, { active: cameraOn && !saving, onDetect: save });

  const submitTyped = (e) => {
    e.preventDefault();
    const code = normalizeBarcode(typed);
    if (!code) {
      setError(t('barcodeScan.invalid', 'That is not a valid barcode. Check the numbers under the stripes (8, 12 or 13 digits).'));
      return;
    }
    save(code);
  };

  return (
    <Modal title={bottle.barcode ? t('barcodeScan.titleChange', 'Change barcode') : t('barcodeScan.title', 'Add barcode')} onClose={onClose} showClose trapFocus>
      {bottle.barcode && (
        <p className="barcode-scan-current">
          {t('barcodeScan.current', 'Saved now: {{code}}', { code: bottle.barcode })}
        </p>
      )}
      {cameraError ? (
        <p className="barcode-scan-camera-error" role="status">{cameraError}</p>
      ) : (
        <div className="barcode-scan-viewfinder">
          <video ref={videoRef} autoPlay playsInline muted className="barcode-scan-video" />
          <p className="barcode-scan-hint">
            {saving ? t('barcodeScan.saving', 'Saving…') : t('barcodeScan.hint', 'Point the camera at the barcode on the bottle.')}
          </p>
        </div>
      )}

      <form onSubmit={submitTyped} className="barcode-scan-form">
        <label htmlFor={inputId}>{t('barcodeScan.typeLabel', 'Or type the numbers under the stripes')}</label>
        <div className="barcode-scan-row">
          <input
            id={inputId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={20}
            value={typed}
            onChange={(e) => { setTyped(e.target.value); setError(null); }}
            disabled={saving}
          />
          <button type="submit" className="btn btn-primary" disabled={saving || !typed.trim()}>
            {t('barcodeScan.save', 'Save')}
          </button>
        </div>
      </form>

      {error && <p className="error-message" role="alert">{error}</p>}

      <div className="modal-actions">
        {bottle.barcode && (
          <button type="button" className="btn btn-secondary barcode-scan-remove" onClick={() => save('')} disabled={saving}>
            {t('barcodeScan.remove', 'Remove barcode')}
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  );
}
