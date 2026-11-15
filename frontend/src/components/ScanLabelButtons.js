import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The two ways into a label scan on a camera prompt card: the camera, and a
 * photo already on the device (a gallery picture or a shop screenshot).
 * Shared by Add bottle and Add to wishlist; both hand the file to the same
 * label-scan hook (hooks/useLabelScanner → scanFile).
 *
 * @param {string}   cameraLabel — the camera button's text (each page words it)
 * @param {Function} onCamera    — opens the viewfinder
 * @param {Function} onFile      — called with the chosen File
 */
export default function ScanLabelButtons({ cameraLabel, onCamera, onFile }) {
  const { t } = useTranslation();
  const fileRef = useRef(null);

  const handleChange = (e) => {
    const file = e.target.files && e.target.files[0];
    // Cleared so choosing the same photo again still fires a change.
    e.target.value = '';
    if (file && onFile) onFile(file);
  };

  return (
    <div className="scan-label-buttons">
      <button type="button" className="btn btn-primary" onClick={onCamera}>
        {cameraLabel}
      </button>
      <button type="button" className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
        {t('camera.choosePhoto')}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={handleChange}
        data-testid="scan-label-file"
      />
    </div>
  );
}
