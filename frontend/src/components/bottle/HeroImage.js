import { useState, Suspense } from 'react';
import { lazy } from '../../utils/lazyWithReload';
import { useTranslation } from 'react-i18next';
import AuthImage from '../AuthImage';
import { swatchType } from '../../utils/wineColour';

const ImageGallery = lazy(() => import('../ImageGallery'));

// `vintageImage` / `vintageImageCredit`: a public photo of this wine AND
// vintage by anyone, shown before the wine's generic registry image, which
// may be another year's label (support ticket 2026-10-09).
function HeroImage({ bottle, wine, defaultImage, pendingImage, vintageImage, vintageImageCredit, isPending, displayName, canEdit, onSetDefault }) {
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
            vintage={bottle.vintage}
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

  // Fallback: single image (default, pending, this vintage's public photo, or wine.image)
  if (defaultImage || pendingImage || vintageImage || wine?.image) {
    const ownImage = defaultImage || pendingImage;
    const credit = ownImage ? null : (vintageImage ? vintageImageCredit : wine?.imageCredit);
    return (
      <div className="bd-wine-image-wrap">
        <AuthImage
          src={ownImage || vintageImage || wine.image}
          alt={displayName}
          className="bd-wine-image"
          onError={e => { e.target.style.display = 'none'; }}
        />
        {credit && <span className="bd-wine-image-credit">{credit}</span>}
        {(isPending || (pendingImage && !wine?.image && !vintageImage && !defaultImage)) && (
          <span className="bd-pending-badge">{t('bottleDetail.pendingReview', 'Pending review')}</span>
        )}
      </div>
    );
  }

  // No image at all
  return (
    <div className={`bd-wine-placeholder ${swatchType(wine, '')}`}>
      {isPending && (
        <span className="bd-pending-badge">{t('bottleDetail.pendingReview', 'Pending review')}</span>
      )}
    </div>
  );
}

export default HeroImage;
