import { useState, Suspense } from 'react';
import { lazy } from '../../utils/lazyWithReload';
import { useTranslation } from 'react-i18next';
import AuthImage from '../AuthImage';
import BottlePlaceholder from '../BottlePlaceholder';

const ImageGallery = lazy(() => import('../ImageGallery'));

// `vintageImage` / `vintageImageCredit`: the vintage's official photo, shown
// before the wine's registry image, which may be another year's label.
// `otherVintageImage`: the viewer's own photo of another vintage, only when
// the wine has no image at all (support ticket 2026-10-09).
function HeroImage({ bottle, wine, defaultImage, pendingImage, vintageImage, vintageImageCredit, otherVintageImage, isPending, displayName, canEdit, onSetDefault }) {
  const { t } = useTranslation();
  const [galleryEmpty, setGalleryEmpty] = useState(false);
  // A photo that fails to load falls back to the drawn bottle, not a blank;
  // remembered by address, so a new photo is tried again.
  const [failedSrc, setFailedSrc] = useState(null);
  const photoSrc = defaultImage || pendingImage || vintageImage || wine?.image || otherVintageImage;

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
  if (photoSrc && photoSrc !== failedSrc) {
    const ownImage = defaultImage || pendingImage;
    const registryImage = vintageImage || wine?.image;
    const credit = ownImage || !registryImage ? null : (vintageImage ? vintageImageCredit : wine?.imageCredit);
    return (
      <div className="bd-wine-image-wrap">
        <AuthImage
          src={ownImage || registryImage || otherVintageImage}
          alt={displayName}
          className="bd-wine-image"
          onError={() => setFailedSrc(photoSrc)}
        />
        {credit && <span className="bd-wine-image-credit">{credit}</span>}
        {(isPending || (pendingImage && !wine?.image && !defaultImage)) && (
          <span className="bd-pending-badge">{t('bottleDetail.pendingReview', 'Pending review')}</span>
        )}
      </div>
    );
  }

  // No image at all: a drawn bottle with the wine's name on its label — for a
  // bottle still waiting on its wine request, the name the member asked for
  // (release audit 2026-10-13: it drew a blank label).
  const request = bottle?.pendingWineRequest;
  const labelWine = wine || (request && {
    name: request.wineName,
    producer: request.producer,
    type: request.hints?.type?.toLowerCase(),
  });
  return (
    <div className="bd-wine-placeholder bd-wine-placeholder--drawn">
      <BottlePlaceholder wine={labelWine} vintage={bottle?.vintage} title={displayName} />
      {isPending && (
        <span className="bd-pending-badge">{t('bottleDetail.pendingReview', 'Pending review')}</span>
      )}
    </div>
  );
}

export default HeroImage;
