import { useState, Suspense } from 'react';
import { lazy } from '../../utils/lazyWithReload';
import { useTranslation } from 'react-i18next';
import AuthImage from '../AuthImage';
import { swatchType } from '../../utils/wineColour';

const ImageGallery = lazy(() => import('../ImageGallery'));

// `vintageImage` / `vintageImageCredit`: the vintage's official photo, shown
// before the wine's registry image, which may be another year's label.
// `otherVintageImage`: the viewer's own photo of another vintage, only when
// the wine has no image at all (support ticket 2026-10-09).
function HeroImage({ bottle, wine, defaultImage, pendingImage, vintageImage, vintageImageCredit, otherVintageImage, isPending, displayName, canEdit, onSetDefault }) {
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

  // Fallback: single image — default, own photo of this bottle or vintage,
  // the vintage's official photo, the wine's image, own photo of another vintage.
  if (defaultImage || pendingImage || vintageImage || wine?.image || otherVintageImage) {
    const ownImage = defaultImage || pendingImage;
    const registryImage = vintageImage || wine?.image;
    const credit = ownImage || !registryImage ? null : (vintageImage ? vintageImageCredit : wine?.imageCredit);
    return (
      <div className="bd-wine-image-wrap">
        <AuthImage
          src={ownImage || registryImage || otherVintageImage}
          alt={displayName}
          className="bd-wine-image"
          onError={e => { e.target.style.display = 'none'; }}
        />
        {credit && <span className="bd-wine-image-credit">{credit}</span>}
        {(isPending || (pendingImage && !wine?.image && !defaultImage)) && (
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
