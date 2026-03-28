import { useState, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import AuthImage from '../AuthImage';

const ImageGallery = lazy(() => import('../ImageGallery'));

function HeroImage({ bottle, wine, defaultImage, pendingImage, isPending, displayName, canEdit, onSetDefault }) {
  const { t } = useTranslation();
  const [galleryEmpty, setGalleryEmpty] = useState(false);

  // Show carousel using bottleId — the API now returns both bottle-specific
  // and approved wine-level images, so the user can pick any as their default
  if (bottle?._id && !galleryEmpty) {
    return (
      <div className="bd-wine-image-wrap">
        <Suspense fallback={null}>
          <ImageGallery
            bottleId={bottle._id}
            size="large"
            onEmpty={() => setGalleryEmpty(true)}
            onSetDefault={canEdit ? onSetDefault : undefined}
          />
        </Suspense>
        {isPending && (
          <span className="bd-pending-badge">{t('bottleDetail.pendingReview', 'Pending review')}</span>
        )}
      </div>
    );
  }

  // Fallback: single image (default, pending, or wine.image)
  if (defaultImage || pendingImage || wine?.image) {
    return (
      <div className="bd-wine-image-wrap">
        <AuthImage
          src={defaultImage || pendingImage || wine.image}
          alt={displayName}
          className="bd-wine-image"
          onError={e => { e.target.style.display = 'none'; }}
        />
        {wine?.imageCredit && !defaultImage && <span className="bd-wine-image-credit">{wine.imageCredit}</span>}
        {(isPending || (pendingImage && !wine?.image && !defaultImage)) && (
          <span className="bd-pending-badge">{t('bottleDetail.pendingReview', 'Pending review')}</span>
        )}
      </div>
    );
  }

  // No image at all
  return (
    <div className={`bd-wine-placeholder ${wine?.type || ''}`}>
      {isPending && (
        <span className="bd-pending-badge">{t('bottleDetail.pendingReview', 'Pending review')}</span>
      )}
    </div>
  );
}

export default HeroImage;
