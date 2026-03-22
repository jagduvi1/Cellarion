import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth, usePlan } from '../contexts/AuthContext';
import { getBottle, updateBottle, consumeBottle, setBottleDefaultImage } from '../api/bottles';
import { getRacks } from '../api/racks';
import { getCellarLayout } from '../api/cellarLayout';
import { toInputDate, getMaturityStatus } from '../utils/drinkStatus';
import { fetchRates, convertAmount, convertAmountHistorical } from '../utils/currency';
import { calculatePriceChange } from '../utils/priceHistoryUtils';
import { getMaturityPhases, isPhaseActive } from '../utils/maturityUtils';
import { CURRENCIES } from '../config/currencies';
import AuthImage from '../components/AuthImage';
import RatingInput from '../components/RatingInput';
import RatingDisplay from '../components/RatingDisplay';
import ReviewCard from '../components/ReviewCard';
import { getWineReviews } from '../api/reviews';
import { fromNormalized } from '../utils/ratingUtils';
import './BottleDetail.css';

// Lazy-load heavy components only needed on user interaction
const ImageUpload = lazy(() => import('../components/ImageUpload'));
const ImageGallery = lazy(() => import('../components/ImageGallery'));
const ReportWineModal = lazy(() => import('../components/ReportWineModal'));
const ReviewForm = lazy(() => import('../components/ReviewForm'));
const ConsumeModal = lazy(() => import('../components/ConsumeModal').then(m => ({ default: m.ConsumeModal })));
const SuggestGrapesModal = lazy(() => import('../components/SuggestGrapesModal').then(m => ({ default: m.SuggestGrapesModal })));

function BottleDetail() {
  const { t } = useTranslation();
  const { id: cellarId, bottleId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  const [bottle, setBottle] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [cellarColor, setCellarColor] = useState(null);
  const [rackInfo, setRackInfo] = useState(null);
  const [vintageProfile, setVintageProfile] = useState(null);
  const [priceHistory, setPriceHistory] = useState(null);
  const [rates, setRates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [consumeOpen, setConsumeOpen] = useState(false);
  const [suggestGrapesOpen, setSuggestGrapesOpen] = useState(false);
  const [reportWineOpen, setReportWineOpen] = useState(false);
  const [reviewFormOpen, setReviewFormOpen] = useState(false);
  const [wineReviews, setWineReviews] = useState([]);
  const [communityRating, setCommunityRating] = useState(null);
  const [reviewAudience, setReviewAudience] = useState('all');
  const [reviewVintage, setReviewVintage] = useState('this');
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewPages, setReviewPages] = useState(0);
  const [pendingImage, setPendingImage] = useState(null);
  const [defaultImage, setDefaultImage] = useState(null);

  useEffect(() => {
    fetchBottle();
    fetchRackInfo();
  }, [bottleId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch reviews when audience or vintage filter changes
  useEffect(() => {
    const wineId = bottle?.wineDefinition?._id;
    if (wineId) fetchWineReviews(wineId, { audience: reviewAudience, vintage: reviewVintage, page: 1 });
  }, [reviewAudience, reviewVintage]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchBottle = async () => {
    try {
      const res = await getBottle(apiFetch, bottleId);
      const data = await res.json();
      if (res.ok) {
        setBottle(data.bottle);
        setUserRole(data.userRole);
        setCellarColor(data.cellarColor || null);
        if (data.pendingImageUrl) {
          const API_URL = process.env.REACT_APP_API_URL || '';
          const url = data.pendingImageUrl.startsWith('http')
            ? data.pendingImageUrl
            : `${API_URL}${data.pendingImageUrl}`;
          setPendingImage(url);
        }
        if (data.defaultImageUrl) {
          const API_URL = process.env.REACT_APP_API_URL || '';
          const url = data.defaultImageUrl.startsWith('http')
            ? data.defaultImageUrl
            : `${API_URL}${data.defaultImageUrl}`;
          setDefaultImage(url);
        }
        // Fetch community reviews for this wine
        const wineObj = data.bottle?.wineDefinition;
        if (wineObj?._id) {
          fetchWineReviews(wineObj._id);
          if (wineObj.communityRating?.reviewCount > 0) {
            setCommunityRating(wineObj.communityRating);
          }
        }
        // Fetch the sommelier maturity profile for this wine+vintage
        const wine = data.bottle?.wineDefinition;
        const vintage = data.bottle?.vintage;
        if (wine?._id && vintage && vintage !== 'NV') {
          fetchVintageProfile(wine._id, vintage);
          fetchPriceHistory(wine._id, vintage);
          fetchRates().then(r => { if (r) setRates(r); });
        }
      } else {
        setError(data.error || 'Failed to load bottle');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const fetchWineReviews = async (wineId, opts = {}) => {
    try {
      const audience = opts.audience ?? reviewAudience;
      const vintageFilter = opts.vintage ?? reviewVintage;
      const page = opts.page ?? 1;

      const params = new URLSearchParams();
      params.set('limit', '10');
      params.set('page', String(page));
      params.set('audience', audience);

      if (vintageFilter === 'this' && bottle?.vintage) {
        params.set('vintage', bottle.vintage);
      } else if (vintageFilter !== 'all' && vintageFilter !== 'this') {
        params.set('vintage', vintageFilter);
      }

      const res = await getWineReviews(apiFetch, wineId, params.toString());
      const data = await res.json();
      if (res.ok) {
        setWineReviews(data.reviews || []);
        setReviewTotal(data.total || 0);
        setReviewPages(data.pages || 0);
        setReviewPage(page);
      }
    } catch {
      // Non-critical
    }
  };

  const fetchVintageProfile = async (wineId, vintage) => {
    try {
      const res = await apiFetch(
        `/api/somm/maturity/lookup?wine=${wineId}&vintage=${vintage}`
      );
      const data = await res.json();
      if (res.ok) setVintageProfile(data.profile);
    } catch {
      // Non-critical — silently ignore
    }
  };

  const fetchPriceHistory = async (wineId, vintage) => {
    try {
      const res = await apiFetch(
        `/api/somm/prices/lookup?wine=${wineId}&vintage=${vintage}`
      );
      const data = await res.json();
      if (res.ok) setPriceHistory(data.history || []);
      else setPriceHistory([]);
    } catch {
      setPriceHistory([]);
    }
  };

  const fetchRackInfo = async () => {
    try {
      const [racksRes, layoutRes] = await Promise.all([
        getRacks(apiFetch, cellarId),
        getCellarLayout(apiFetch, cellarId),
      ]);
      const racksData = await racksRes.json();
      const layoutData = await layoutRes.json();
      if (racksRes.ok) {
        for (const rack of racksData.racks) {
          for (const slot of rack.slots) {
            const bid = slot.bottle?._id || slot.bottle;
            if (bid && bid.toString() === bottleId) {
              // Check if this rack is placed in the 3D room layout
              const placements = layoutData.layout?.rackPlacements || [];
              const inRoom = placements.some(
                rp => (rp.rack?._id || rp.rack) === rack._id
              );
              setRackInfo({ rackId: rack._id, rackName: rack.name, position: slot.position, inRoom });
              return;
            }
          }
        }
      }
    } catch {}
  };

  const handleBottleUpdated = (updated) => {
    setBottle(updated);
    setEditing(false);
  };

  const handleConsumeConfirm = async (reason, note, rating, consumedRatingScale) => {
    try {
      const res = await consumeBottle(apiFetch, bottleId, { reason, note, rating, consumedRatingScale });
      const data = await res.json();
      if (res.ok) {
        navigate(`/cellars/${cellarId}`);
      } else {
        alert(data.error || 'Failed to remove bottle');
      }
    } catch {
      alert('Network error');
    }
  };

  if (error) return <div className="alert alert-error">{error}</div>;

  const wine = bottle?.wineDefinition;
  const isPending = !wine && !!bottle?.pendingWineRequest;
  const displayName = wine?.name || bottle?.pendingWineRequest?.wineName;
  const displayProducer = wine?.producer || bottle?.pendingWineRequest?.producer;
  const canEdit = userRole === 'owner' || userRole === 'editor';

  return (
    <div className="bottle-detail-page">
      {/* ── Clean header ── */}
      <div className="bd-page-header">
        <div className="bd-header-top">
          <Link to={`/cellars/${cellarId}`} className="back-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
            {t('bottleDetail.backToCellar')}
          </Link>
          {!loading && canEdit && !editing && (
            <div className="bd-header-actions">
              <button className="btn btn-secondary btn-small" onClick={() => setEditing(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                <span className="bd-btn-label">{t('bottleDetail.editDetails')}</span>
              </button>
              <button className="btn btn-consume btn-small" onClick={() => setConsumeOpen(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2h8l4 10H4L8 2z"/><path d="M12 12v6"/><path d="M8 22h8"/></svg>
                <span className="bd-btn-label">{t('bottleDetail.removeBottle')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="loading">{t('bottleDetail.loadingBottle')}</div>
      ) : <>
      {/* ── Wine hero card ── */}
      <div className="bd-wine-header card">
        <div className="bd-wine-identity">
          <HeroImage
            bottle={bottle}
            wine={wine}
            defaultImage={defaultImage}
            pendingImage={pendingImage}
            isPending={isPending}
            displayName={displayName}
            canEdit={canEdit}
            onSetDefault={async (imageId) => {
              const res = await setBottleDefaultImage(apiFetch, bottle._id, imageId);
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to set default image');
              }
            }}
          />
          <div className="bd-wine-meta">
            <h1 className={cellarColor ? 'cellar-accent-border' : ''} style={cellarColor ? { '--cellar-color': cellarColor } : undefined}>
              {displayName || t('common.unknownWine')}
            </h1>
            <p className="bd-producer">
              {displayProducer}
              {wine?.country?.name && <span className="bd-country"> · {wine.country.name}</span>}
            </p>
            {wine?.type && (
              <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
            )}
          </div>
        </div>
      </div>

      {/* Bottle details or edit form */}
      {editing ? (
        <EditForm
          bottle={bottle}
          onSaved={handleBottleUpdated}
          onCancel={() => setEditing(false)}
          onImageUploaded={(url) => setPendingImage(url)}
        />
      ) : (
        <ViewDetails
          bottle={bottle}
          rackInfo={rackInfo}
          cellarId={cellarId}
          vintageProfile={vintageProfile}
          priceHistory={priceHistory}
          rates={rates}
          userCurrency={user?.preferences?.currency || 'USD'}
          canEdit={canEdit}
          hasImage={!!(defaultImage || pendingImage || bottle.wineDefinition?.image)}
          onEdit={() => setEditing(true)}
          onSuggestGrapes={() => setSuggestGrapesOpen(true)}
          onRemove={() => setConsumeOpen(true)}
          onReportWine={() => setReportWineOpen(true)}
        />
      )}

      {/* ── Reviews section ── */}
      {wine && (
        <div className="bd-reviews card">
          <div className="bd-reviews__header">
            <h2>{t('reviews.communityReviews', 'Reviews')}</h2>
            {communityRating && communityRating.reviewCount > 0 && (
              <span className="bd-reviews__avg">
                {fromNormalized(communityRating.averageNormalized, user?.preferences?.ratingScale || '5').toFixed(1)}
                {user?.preferences?.ratingScale === '100' ? 'pts' : user?.preferences?.ratingScale === '20' ? '/20' : '★'}
                <span className="bd-reviews__count">({communityRating.reviewCount})</span>
              </span>
            )}
          </div>
          <div className="bd-reviews__filters">
            <select
              value={reviewAudience}
              onChange={e => setReviewAudience(e.target.value)}
              className="bd-reviews__filter-select"
            >
              <option value="all">{t('reviews.audienceAll', 'All')}</option>
              <option value="mine">{t('reviews.audienceMine', 'My Reviews')}</option>
              <option value="following">{t('reviews.audienceFollowing', 'Following')}</option>
            </select>
            <select
              value={reviewVintage}
              onChange={e => setReviewVintage(e.target.value)}
              className="bd-reviews__filter-select"
            >
              <option value="this">{t('reviews.vintageThis', 'This vintage')}</option>
              <option value="all">{t('reviews.vintageAll', 'All vintages')}</option>
            </select>
          </div>
          {wineReviews.length > 0 ? (
            wineReviews.map(review => (
              <ReviewCard key={review._id} review={review} showWine={false} />
            ))
          ) : (
            <p className="bd-reviews__empty">{t('reviews.noReviews', 'No reviews yet. Be the first to review this wine!')}</p>
          )}
          {reviewPages > 1 && (
            <div className="bd-reviews__pagination">
              <button
                className="btn btn-secondary btn-small"
                disabled={reviewPage <= 1}
                onClick={() => fetchWineReviews(wine._id, { page: reviewPage - 1 })}
              >
                {t('common.previous', 'Previous')}
              </button>
              <span className="bd-reviews__page-info">{reviewPage} / {reviewPages}</span>
              <button
                className="btn btn-secondary btn-small"
                disabled={reviewPage >= reviewPages}
                onClick={() => fetchWineReviews(wine._id, { page: reviewPage + 1 })}
              >
                {t('common.next', 'Next')}
              </button>
            </div>
          )}
          <button
            className="btn btn-primary btn-small"
            onClick={() => setReviewFormOpen(true)}
          >
            {t('reviews.writeReview', 'Write a Review')}
          </button>
        </div>
      )}

      <Suspense fallback={null}>
        {reviewFormOpen && wine && (
          <ReviewForm
            wineDefinition={wine._id}
            wineName={wine.name}
            defaultVintage={bottle?.vintage !== 'NV' ? bottle?.vintage : ''}
            onClose={() => setReviewFormOpen(false)}
            onSaved={() => {
              fetchWineReviews(wine._id);
              setCommunityRating(null);
            }}
          />
        )}
      </Suspense>

      </>}

      {/* ── Mobile action bar (sticky bottom) ── */}
      {!loading && canEdit && !editing && (
        <div className="bd-mobile-actions">
          <button className="bd-mobile-action-btn bd-mobile-action-edit" onClick={() => setEditing(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            {t('bottleDetail.editDetails')}
          </button>
          <button className="bd-mobile-action-btn bd-mobile-action-consume" onClick={() => setConsumeOpen(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2h8l4 10H4L8 2z"/><path d="M12 12v6"/><path d="M8 22h8"/></svg>
            {t('bottleDetail.removeBottle')}
          </button>
        </div>
      )}

      <Suspense fallback={null}>
        {consumeOpen && (
          <ConsumeModal
            wineName={displayName}
            defaultRatingScale={user?.preferences?.ratingScale || '5'}
            onConfirm={handleConsumeConfirm}
            onCancel={() => setConsumeOpen(false)}
          />
        )}

        {suggestGrapesOpen && (
          <SuggestGrapesModal
            wine={wine}
            onClose={() => setSuggestGrapesOpen(false)}
          />
        )}

        {reportWineOpen && bottle?.wineDefinition && (
          <ReportWineModal
            wine={bottle.wineDefinition}
            onClose={() => setReportWineOpen(false)}
          />
        )}
      </Suspense>
    </div>
  );
}

// ── Hero image: shows carousel from bottle gallery (includes wine images) ──
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

// ── Dismissible community contribution prompt ──
function ContributePrompt({ storageKey, icon, title, message, actionLabel, onAction, actionHref }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });

  if (dismissed) return null;

  const dismiss = () => {
    try { localStorage.setItem(storageKey, '1'); } catch {}
    setDismissed(true);
  };

  return (
    <div className="bd-contribute">
      <button className="bd-contribute__dismiss" onClick={dismiss} aria-label="Dismiss">×</button>
      <div className="bd-contribute__body">
        <span className="bd-contribute__icon">{icon}</span>
        <div className="bd-contribute__text">
          <strong className="bd-contribute__title">{title}</strong>
          <p className="bd-contribute__msg">{message}</p>
        </div>
      </div>
      {actionHref ? (
        <Link to={actionHref} className="bd-contribute__action">{actionLabel} →</Link>
      ) : (
        <button className="bd-contribute__action" onClick={onAction}>{actionLabel} →</button>
      )}
    </div>
  );
}

// ── View mode ──
function ViewDetails({ bottle, rackInfo, cellarId, vintageProfile, priceHistory, rates, userCurrency, canEdit, hasImage, onEdit, onSuggestGrapes, onRemove, onReportWine }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { plan, hasFeature } = usePlan();
  const hasAgingMaturity = hasFeature('agingMaturity');
  const hasPriceEvolution = hasFeature('priceEvolution');
  const maturityStatus = getMaturityStatus(vintageProfile);
  const [showSommNotes, setShowSommNotes] = useState(false);
  const wine = bottle.wineDefinition;
  const grapes = wine?.grapes || [];

  return (
    <div className="bd-details card">
      <div className="bd-detail-grid">
        <div className="bd-detail-item">
          <span className="bd-detail-label">{t('bottleDetail.vintage')}</span>
          <span className="bd-detail-value">{bottle.vintage}</span>
        </div>
        {bottle.bottleSize && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.size')}</span>
            <span className="bd-detail-value">{bottle.bottleSize}</span>
          </div>
        )}
        {bottle.rating && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.ratingLabel')}</span>
            <span className="bd-detail-value">
              <RatingDisplay value={bottle.rating} scale={bottle.ratingScale || '5'} preferredScale={user?.preferences?.ratingScale} />
            </span>
          </div>
        )}
        {bottle.price && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.pricePaid')}</span>
            <span className="bd-detail-value">
              {bottle.price} {bottle.currency}
              {(() => {
                const c = convertAmountHistorical(bottle.price, bottle.currency, userCurrency, bottle.priceCurrencyRates, rates);
                return c !== null ? (
                  <span
                    className="bd-detail-converted"
                    title={t('bottleDetail.priceAtEntryTooltip')}
                  > ≈ {c.toLocaleString()} {userCurrency}</span>
                ) : null;
              })()}
            </span>
          </div>
        )}
      </div>

      {/* Missing photo contribution prompt */}
      {!hasImage && canEdit && (
        <ContributePrompt
          storageKey={`cellarion_contrib_photo_${wine?._id}`}
          icon="📷"
          title={t('bottleDetail.contributePhotoTitle', 'Help the community')}
          message={t('bottleDetail.contributePhotoMsg', 'This wine has no photo yet. Adding one helps other collectors recognise it — it will be reviewed before going public.')}
          actionLabel={t('bottleDetail.contributePhotoAction', 'Add a photo')}
          onAction={onEdit}
        />
      )}

      {/* Grapes */}
      <div className="bd-section">
        <span className="bd-section-label">{t('bottleDetail.grapes', 'Grape Varieties')}</span>
        {grapes.length > 0 ? (
          <div className="bd-grapes">
            {grapes.map(g => (
              <span key={g._id} className="bd-grape-pill">{g.name}</span>
            ))}
          </div>
        ) : canEdit ? (
          <ContributePrompt
            storageKey={`cellarion_contrib_grapes_${wine?._id}`}
            icon="🍇"
            title={t('bottleDetail.contributeGrapesTitle', 'Help the community')}
            message={t('bottleDetail.contributeGrapesMsg', 'Grape varieties aren\'t listed for this wine yet. Suggest them and our team will review.')}
            actionLabel={t('bottleDetail.contributeGrapesAction', 'Suggest grapes')}
            onAction={onSuggestGrapes}
          />
        ) : (
          <span className="bd-missing-hint">{t('bottleDetail.noGrapes', 'No grape varieties listed')}</span>
        )}
      </div>

      {/* Sommelier maturity section — premium feature, not shown for NV */}
      {bottle.vintage && bottle.vintage !== 'NV' && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.sommMaturity')}</span>
          {hasAgingMaturity ? (
            !vintageProfile ? (
              <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>
            ) : vintageProfile.status === 'pending' ? (
              <div className="bd-maturity-pending">
                <span className="maturity-badge maturity-badge--pending">{t('bottleDetail.awaitingSommelier')}</span>
                <span className="bd-maturity-note">
                  {t('bottleDetail.sommelierWillSet')}
                </span>
              </div>
            ) : (
              <div className="bd-maturity-reviewed">
                {maturityStatus && (
                  <span className={`maturity-badge maturity-badge--${maturityStatus.status}`}>
                    {maturityStatus.label}
                  </span>
                )}
                <MaturityPhaseTable profile={vintageProfile} />
                {vintageProfile.sommNotes && (
                  <div className="bd-somm-notes-toggle">
                    <button
                      className="bd-somm-notes-btn"
                      onClick={() => setShowSommNotes(v => !v)}
                      aria-expanded={showSommNotes}
                    >
                      {t('bottleDetail.sommNotes')}
                      <span className={`bd-somm-notes-chevron${showSommNotes ? ' bd-somm-notes-chevron--open' : ''}`}>›</span>
                    </button>
                    {showSommNotes && (
                      <p className="bd-maturity-notes">{vintageProfile.sommNotes}</p>
                    )}
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="bd-price-evolution bd-price-evolution--locked">
              <span className="bd-price-evolution__icon" aria-hidden="true">🔒</span>
              <div>
                <strong>{t('bottleDetail.premiumFeature')}</strong>
                <p>{t('bottleDetail.agingMaturityPremiumDesc')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Rack location */}
      {rackInfo && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.rackLocation')}</span>
          <Link
            to={rackInfo.inRoom
              ? `/cellars/${cellarId}/room?focusRack=${rackInfo.rackId}&highlight=${bottle._id}`
              : `/cellars/${cellarId}/racks?highlight=${bottle._id}`}
            className="bd-rack-link"
          >
            <span aria-hidden="true">📍</span> {rackInfo.rackName} · {t('bottleDetail.rackSlot')} {rackInfo.position}
          </Link>
        </div>
      )}

      {/* Notes */}
      {bottle.notes && (
        <div className="bd-section">
          <span className="bd-section-label">{t('common.notes')}</span>
          <p className="bd-notes">{bottle.notes}</p>
        </div>
      )}

      {/* Purchase info */}
      {(bottle.purchaseDate || bottle.purchaseLocation || bottle.purchaseUrl) && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.purchase')}</span>
          <div className="bd-purchase">
            {bottle.purchaseDate && (
              <span>{new Date(bottle.purchaseDate).toLocaleDateString()}</span>
            )}
            {bottle.purchaseLocation && <span>{bottle.purchaseLocation}</span>}
            {bottle.purchaseUrl && (
              <a href={bottle.purchaseUrl} target="_blank" rel="noreferrer" className="bd-purchase-link">
                <span aria-hidden="true">🔗</span> Link
              </a>
            )}
          </div>
        </div>
      )}

      {/* Price Evolution — premium feature, not shown for NV */}
      {bottle.vintage !== 'NV' && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.priceEvolution')}</span>
          {hasPriceEvolution ? (
            <PriceHistoryTimeline history={priceHistory} rates={rates} userCurrency={userCurrency} />
          ) : (
            <div className="bd-price-evolution bd-price-evolution--locked">
              <span className="bd-price-evolution__icon" aria-hidden="true">🔒</span>
              <div>
                <strong>{t('bottleDetail.premiumFeature')}</strong>
                <p>{t('bottleDetail.premiumFeatureDesc')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {bottle.wineDefinition && (
        <div className="bd-report-wine">
          <button className="btn-report-wine" onClick={onReportWine}>
            Report an issue with this wine
          </button>
        </div>
      )}
    </div>
  );
}

// ── Edit form ──
const API_URL = process.env.REACT_APP_API_URL || '';

function EditForm({ bottle, onSaved, onCancel, onImageUploaded }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const galleryRef = useRef(null);
  const [form, setForm] = useState({
    vintage:          bottle.vintage     || '',
    rating:           bottle.rating      || '',
    ratingScale:      bottle.ratingScale || '5',
    notes:            bottle.notes   || '',
    price:            bottle.price   || '',
    // If bottle has a price, keep stored currency (price and currency must stay in sync).
    // If no price yet, default to user's preference so they don't have to change it every time.
    currency:         bottle.price ? (bottle.currency || 'USD') : (user?.preferences?.currency || bottle.currency || 'USD'),
    bottleSize:       bottle.bottleSize || '750ml',
    purchaseDate:     toInputDate(bottle.purchaseDate),
    purchaseLocation: bottle.purchaseLocation || '',
    purchaseUrl:      bottle.purchaseUrl || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const hasWineImage = !!bottle.wineDefinition?.image;

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await updateBottle(apiFetch, bottle._id, {
        ...form,
        price:  form.price  ? parseFloat(form.price)  : null,
        rating: form.rating ? parseFloat(form.rating) : null,
        ratingScale: form.ratingScale || '5',
        purchaseDate: form.purchaseDate || null,
      });
      const data = await res.json();
      if (res.ok) onSaved(data.bottle);
      else setError(data.error || 'Failed to save');
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="bd-edit-form card" onSubmit={handleSave}>
      <h2>{t('bottleDetail.editBottleTitle')}</h2>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="bd-edit-grid">
        <div className="form-group">
          <label>{t('bottleDetail.vintage')}</label>
          <input type="text" value={form.vintage} onChange={set('vintage')} placeholder={t('bottleDetail.vintagePlaceholder')} />
        </div>

        <div className="form-group">
          <label>{t('bottleDetail.ratingLabel')}</label>
          <RatingInput
            value={form.rating}
            scale={form.ratingScale}
            onChange={v => setForm(f => ({ ...f, rating: v ?? '' }))}
            onScaleChange={s => setForm(f => ({ ...f, ratingScale: s, rating: '' }))}
            allowScaleOverride
          />
        </div>

        <div className="form-group">
          <label>{t('common.price')}</label>
          <input type="number" step="0.01" min="0" value={form.price} onChange={set('price')} placeholder="0.00" />
        </div>

        <div className="form-group">
          <label>{t('common.currency')}</label>
          <select value={form.currency} onChange={set('currency')}>
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>{t('addBottle.bottleSize')}</label>
          <select value={form.bottleSize} onChange={set('bottleSize')}>
            <option>375ml (Half)</option>
            <option>750ml (Standard)</option>
            <option>1.5L (Magnum)</option>
            <option>3L (Double Magnum)</option>
          </select>
        </div>

        <div className="form-group">
          <label>{t('addBottle.purchaseDate')}</label>
          <input type="date" value={form.purchaseDate} onChange={set('purchaseDate')} />
        </div>
      </div>

      <div className="form-group">
        <label>{t('common.notes')}</label>
        <textarea value={form.notes} onChange={set('notes')} rows={4} placeholder={t('addBottle.notesPlaceholder')} />
      </div>

      <div className="form-group">
        <label>{t('addBottle.purchaseLocation')}</label>
        <input type="text" value={form.purchaseLocation} onChange={set('purchaseLocation')} placeholder={t('addBottle.purchaseLocationPlaceholder')} />
      </div>

      <div className="form-group">
        <label>{t('addBottle.purchaseUrl')}</label>
        <input type="url" value={form.purchaseUrl} onChange={set('purchaseUrl')} placeholder="https://…" />
      </div>

      <div className="form-group bd-image-section">
        <label>
          {t('bottleDetail.addWineImage', 'Wine Photo')}
          <span className="bd-label-optional"> ({t('common.optional', 'optional')})</span>
        </label>
        <p className="bd-image-default-hint">{t('bottleDetail.defaultImageHint', 'Click the star to choose which image is shown first.')}</p>
        <Suspense fallback={null}>
          <ImageGallery
            ref={galleryRef}
            bottleId={bottle._id}
            size="medium"
            onSetDefault={async (imageId) => {
              const res = await setBottleDefaultImage(apiFetch, bottle._id, imageId);
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to set default image');
              }
            }}
          />
        </Suspense>
        {!hasWineImage && (
          <>
            <Suspense fallback={null}>
              <ImageUpload
                bottleId={bottle._id}
                wineDefinitionId={bottle.wineDefinition?._id}
                onUploadComplete={(img) => {
                  if (onImageUploaded && img?.originalUrl) {
                    const url = img.originalUrl.startsWith('http')
                      ? img.originalUrl
                      : `${API_URL}${img.originalUrl}`;
                    onImageUploaded(url);
                  }
                  galleryRef.current?.refresh();
                }}
                onProcessingComplete={(url) => {
                  onImageUploaded?.(url);
                  galleryRef.current?.refresh();
                }}
              />
            </Suspense>
            <p className="image-public-notice">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }}>
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              {t('bottleDetail.imageNotice', 'Images are reviewed by an admin before being added to the shared wine registry, where they will be visible to all Cellarion users.')}
            </p>
          </>
        )}
      </div>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : t('bottleDetail.saveChanges')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

// ── 3-phase maturity table shown on bottle detail ──
function MaturityPhaseTable({ profile }) {
  const { t } = useTranslation();
  const CURRENT_YEAR = new Date().getFullYear();

  const phases = getMaturityPhases(profile, {
    early: t('bottleDetail.maturityPhaseEarly'),
    peak:  t('bottleDetail.maturityPhasePeak'),
    late:  t('bottleDetail.maturityPhaseLate'),
  });

  if (phases.length === 0) return null;

  return (
    <div className="bd-maturity-table">
      {phases.map(p => {
        const active = isPhaseActive(p, CURRENT_YEAR);

        const yrsFrom  = p.from  && !isNaN(p.vintageInt) ? p.from  - p.vintageInt : null;
        const yrsUntil = p.until && !isNaN(p.vintageInt) ? p.until - p.vintageInt : null;

        return (
          <div key={p.cls} className={`bd-maturity-row ${active ? 'bd-maturity-row--active' : ''}`}>
            <div className={`bd-maturity-phase-dot bd-maturity-phase-dot--${p.cls}`} />
            <span className="bd-maturity-phase-name">{p.label}</span>
            <span className="bd-maturity-phase-range">
              {p.from && p.until ? `${p.from}–${p.until}` : p.from ? `from ${p.from}` : `until ${p.until}`}
            </span>
            {(yrsFrom !== null) && (
              <span className="bd-maturity-phase-yrs">
                {yrsUntil !== null ? `${yrsFrom}–${yrsUntil} yrs` : `${yrsFrom}+ yrs`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Price history timeline (premium feature) ──
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 1)  return 'today';
  if (days < 7)  return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function PriceHistoryTimeline({ history, rates, userCurrency }) {
  const { t } = useTranslation();
  if (history === null) {
    return <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>;
  }
  if (history.length === 0) {
    return (
      <div className="bd-price-history-empty">
        <span className="bd-no-dates">{t('bottleDetail.noPriceData')}</span>
        <span className="bd-maturity-note">{t('bottleDetail.sommelierAddPricing')}</span>
      </div>
    );
  }

  const latest = history[0];
  const previous = history.length > 1 ? history[1] : null;
  const change = calculatePriceChange(latest, previous);

  // Convert latest price using historically-anchored rates (rate at time of recording)
  const latestConverted = convertAmountHistorical(latest.price, latest.currency, userCurrency, latest.exchangeRates, rates);

  return (
    <div className="bd-price-history">
      <div className="bd-price-latest">
        <span className="bd-price-latest__amount">
          {latest.price.toLocaleString()} {latest.currency}
        </span>
        {latestConverted !== null && (
          <span className="bd-price-converted">≈ {latestConverted.toLocaleString()} {userCurrency}</span>
        )}
        {change && (
          <span className={`bd-price-change bd-price-change--${change.up ? 'up' : 'down'}`}>
            {change.up ? '↑' : '↓'} {Math.abs(change.diff).toFixed(2)} ({change.up ? '+' : ''}{change.pct}%)
          </span>
        )}
      </div>
      <div className="bd-price-latest__meta">
        {timeAgo(latest.setAt)}
        {latest.source && <> · <em>{latest.source}</em></>}
        {latest.setBy?.username && <> · {latest.setBy.username}</>}
      </div>

      {history.length > 1 && (
        <div className="bd-price-timeline">
          {history.slice(1).map((entry, i) => {
            const converted = convertAmountHistorical(entry.price, entry.currency, userCurrency, entry.exchangeRates, rates);
            return (
              <div key={i} className="bd-price-entry">
                <span className="bd-price-entry__price">{entry.price.toLocaleString()} {entry.currency}</span>
                {converted !== null && (
                  <span className="bd-price-entry__converted">≈ {converted.toLocaleString()} {userCurrency}</span>
                )}
                <span className="bd-price-entry__date">{timeAgo(entry.setAt)}</span>
                {entry.source && <span className="bd-price-entry__source">{entry.source}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default BottleDetail;
