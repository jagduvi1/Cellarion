import ImageUpload from '../ImageUpload';
import ImageGallery from '../ImageGallery';

/**
 * The photo part of the bottle details: add a photo of this bottle, and the
 * note on what the registry already shows for the wine. The page owns the
 * uploaded photos and the barcode the wine was found by.
 */
export default function BottlePhotoSection({
  t, selectedWineId, registryHasPhotos, setWineImageCounts, photoPromptReady, selectedWine,
  setUploadedImages, foundByBarcode, barcode, startBarcodeScan,
}) {
  return (
    <>
      <div className="photo-section">
        <div className="photo-section-header">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="photo-section-icon">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
          <span className="photo-section-title">{t('addBottle.bottlePhotos')}</span>
        </div>
        {/* What the registry already holds for this wine. Shown BEFORE the
            uploader so a user who would have re-photographed a wine we can
            already illustrate can see that first. The prompt is softened,
            never removed: ~89% of the registry's official images started
            as a user's bottle photo, and most wines still have none. */}
        {selectedWineId && (
          // The wrapper's margin is applied only when something rendered:
          // ImageGallery returns null while loading and when empty, and
          // most wines have no photo, so an unconditional class left a
          // gap in the common case. Keyed so a wine switch remounts.
          <div className={registryHasPhotos ? 'photo-existing' : undefined}>
            <ImageGallery
              key={selectedWineId}
              wineDefinitionId={selectedWineId}
              size="small"
              onLoaded={(count) => setWineImageCounts(prev => ({ ...prev, [selectedWineId]: count }))}
            />
          </div>
        )}
        {photoPromptReady && (
          <p className="photo-section-lead">
            {registryHasPhotos ? t('addBottle.photosExisting') : t('addBottle.photosNone')}
          </p>
        )}
        <ImageUpload
          wineDefinitionId={selectedWine?._id}
          onUploadComplete={(img) => setUploadedImages(prev => [...prev, img])}
        />
        <p className="photo-section-notice">{t('addBottle.photosNotice')}</p>
      </div>

      {/* The registry learns barcodes only from bottles added with one, so
          ask — once, quietly, at the one step every add path reaches. Below
          the fields and the photo, next to the other way to help: a
          newcomer's first job here is the vintage. The thanks lands where
          the scan was asked for. */}
      {!foundByBarcode && (
        <div className="barcode-ask">
          {barcode ? (
            <p className="selected-wine-barcode-note">
              {t('addBottle.barcodeThanks', 'Thank you — the barcode is saved with this bottle, so the next member who scans it finds this wine straight away.')}
            </p>
          ) : (
            <div className="barcode-help">
              <p>{t('addBottle.barcodeHelp', "Help the community: we're building Cellarion's barcode list together, and it's still small. Scan the barcode on this bottle, and the next member who scans it will find this wine straight away.")}</p>
              <button type="button" className="btn btn-ghost btn-small" onClick={startBarcodeScan}>
                {t('addBottle.barcodeHelpBtn', 'Scan barcode')}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
