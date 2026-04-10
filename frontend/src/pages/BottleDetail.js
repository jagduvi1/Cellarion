import { useState, useEffect, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getBottle, consumeBottle, setBottleDefaultImage } from '../api/bottles';
import { getRacks } from '../api/racks';
import { getCellarLayout } from '../api/cellarLayout';
import { fetchRates } from '../utils/currency';
import SITE_URL from '../config/siteUrl';
import { API_URL } from '../api/apiConstants';
import ReviewCard from '../components/ReviewCard';
import { getWineReviews } from '../api/reviews';
import { fromNormalized } from '../utils/ratingUtils';
import ShareButton from '../components/ShareButton';
import HeroImage from '../components/bottle/HeroImage';
import ConsumedDetails from '../components/bottle/ConsumedDetails';
import EditForm from '../components/bottle/EditForm';
import ViewDetails from '../components/bottle/ViewDetails';
import './BottleDetail.css';

// Lazy-load heavy components only needed on user interaction
const ReportWineModal = lazy(() => import('../components/ReportWineModal'));
const ReviewForm = lazy(() => import('../components/ReviewForm'));
const ConsumeModal = lazy(() => import('../components/ConsumeModal').then(m => ({ default: m.ConsumeModal })));
const SuggestGrapesModal = lazy(() => import('../components/SuggestGrapesModal').then(m => ({ default: m.SuggestGrapesModal })));
const RecommendWineModal = lazy(() => import('../components/RecommendWineModal'));
const JournalEntryForm = lazy(() => import('../components/JournalEntryForm'));

function BottleDetail() {
  const { t } = useTranslation();
  const { id: cellarId, bottleId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fromHistory = location.state?.fromHistory === true;
  const fromChat = location.state?.fromChat === true;
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
  const [reportDefaultReason, setReportDefaultReason] = useState(null);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [journalPrompt, setJournalPrompt] = useState(false);
  const [journalFormOpen, setJournalFormOpen] = useState(false);
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
        // Only fetch rack info for active bottles
        if (data.bottle.status === 'active') fetchRackInfo();
        if (data.pendingImageUrl) {
          const url = data.pendingImageUrl.startsWith('http')
            ? data.pendingImageUrl
            : `${API_URL}${data.pendingImageUrl}`;
          setPendingImage(url);
        }
        if (data.defaultImageUrl) {
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
        // Prompt for journal entry if user hasn't opted out
        const optedOut = localStorage.getItem('cellarion_journal_prompt_optout') === '1';
        if (!optedOut && reason === 'drank') {
          setConsumeOpen(false);
          setJournalPrompt(true);
        } else {
          navigate(`/cellars/${cellarId}`);
        }
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
  const isConsumed = bottle?.status && bottle.status !== 'active';
  const canEdit = !isConsumed && (userRole === 'owner' || userRole === 'editor');
  const canEditConsumed = isConsumed && (userRole === 'owner' || userRole === 'editor');

  return (
    <div className="bottle-detail-page">
      {/* ── Clean header ── */}
      <div className="bd-page-header">
        <div className="bd-header-top">
          <Link to={fromChat ? '/cellar-chat' : (isConsumed || fromHistory ? `/cellars/${cellarId}/history` : `/cellars/${cellarId}`)} className="back-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
            {fromChat ? t('bottleDetail.backToChat', 'Back to chat') : (isConsumed || fromHistory ? t('bottleDetail.backToHistory', 'Back to history') : t('bottleDetail.backToCellar'))}
          </Link>
          {!loading && !editing && (
            <div className="bd-header-actions">
              {canEdit && (
                <>
                  <button className="btn btn-secondary btn-small" onClick={() => setEditing(true)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    <span className="bd-btn-label">{t('bottleDetail.editDetails')}</span>
                  </button>
                  <button className="btn btn-consume btn-small" data-guide="bottle-consume" onClick={() => setConsumeOpen(true)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2h8l4 10H4L8 2z"/><path d="M12 12v6"/><path d="M8 22h8"/></svg>
                    <span className="bd-btn-label">{t('bottleDetail.removeBottle')}</span>
                  </button>
                </>
              )}
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
            <div className="bd-wine-name-row">
              <h1 className={cellarColor ? 'cellar-accent-border' : ''} style={cellarColor ? { '--cellar-color': cellarColor } : undefined}>
                {displayName || t('common.unknownWine')}
              </h1>
              {wine && (
                <ShareButton
                  title={displayName}
                  text={`Check out ${displayName}${displayProducer ? ` by ${displayProducer}` : ''} on Cellarion`}
                  url={`${SITE_URL}/wines/${wine._id}`}
                  onRecommend={() => setRecommendOpen(true)}
                  variant="icon"
                />
              )}
            </div>
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

      {/* ── Consumption details (history bottles only) ── */}
      {isConsumed && (
        <ConsumedDetails bottle={bottle} canEdit={canEditConsumed} onUpdate={setBottle} />
      )}

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
          onReportWine={(reason) => { setReportWineOpen(true); setReportDefaultReason(reason || null); }}
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
            data-guide="bottle-write-review"
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
            defaultReason={reportDefaultReason}
            onClose={() => { setReportWineOpen(false); setReportDefaultReason(null); }}
          />
        )}

        {recommendOpen && wine && (
          <RecommendWineModal
            wineId={wine._id}
            wineName={displayName}
            onClose={() => setRecommendOpen(false)}
          />
        )}

        {journalPrompt && (
          <div className="modal-overlay" onClick={() => { setJournalPrompt(false); navigate(`/cellars/${cellarId}`); }}>
            <div className="modal-box" onClick={e => e.stopPropagation()}>
              <h2>{t('journal.promptTitle', 'Add to your journal?')}</h2>
              <p>{t('journal.promptText', 'Would you like to capture this moment in your wine journal?')}</p>
              <div className="modal-actions" style={{ flexDirection: 'column', gap: '0.5rem' }}>
                <button className="btn btn-primary" onClick={() => { setJournalPrompt(false); setJournalFormOpen(true); }}>
                  {t('journal.yesAddEntry', 'Yes, add journal entry')}
                </button>
                <button className="btn btn-secondary" onClick={() => { setJournalPrompt(false); navigate(`/cellars/${cellarId}`); }}>
                  {t('journal.notNow', 'Not now')}
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: '0.8rem', opacity: 0.6 }}
                  onClick={() => {
                    localStorage.setItem('cellarion_journal_prompt_optout', '1');
                    setJournalPrompt(false);
                    navigate(`/cellars/${cellarId}`);
                  }}
                >
                  {t('journal.dontAskAgain', "Don't ask again")}
                </button>
              </div>
            </div>
          </div>
        )}

        {journalFormOpen && (
          <JournalEntryForm
            prefilledBottle={bottle}
            onClose={() => { setJournalFormOpen(false); navigate(`/cellars/${cellarId}`); }}
            onSaved={() => { setJournalFormOpen(false); navigate(`/cellars/${cellarId}`); }}
          />
        )}
      </Suspense>
    </div>
  );
}


export default BottleDetail;
