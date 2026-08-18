import { useState, useEffect, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { useAuth } from '../contexts/AuthContext';
import { getBottle, consumeBottle, setBottleDefaultImage, undoBottle, openBottle, restoreBottle } from '../api/bottles';
import { isReserved, reservationSummary } from '../utils/reservation';
import OpenBottlePanel from '../components/bottle/OpenBottlePanel';
import { PRESERVATION_METHODS } from '../utils/openBottle';
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
import BottleJourney from '../components/BottleJourney';
import OwnerInquiryCard from '../components/bottle/OwnerInquiryCard';
import PersonalDataCard from '../components/bottle/PersonalDataCard';
import DialogBox from '../components/DialogBox';
import JournalPrompt, { journalPromptOptedOut } from '../components/JournalPrompt';
import './BottleDetail.css';

// Lazy-load heavy components only needed on user interaction
const ReportWineModal = lazy(() => import('../components/ReportWineModal'));
const MoveBottleModal = lazy(() => import('../components/MoveBottleModal'));
const ReviewForm = lazy(() => import('../components/ReviewForm'));
const ConsumeModal = lazy(() => import('../components/ConsumeModal').then(m => ({ default: m.ConsumeModal })));
const SuggestGrapesModal = lazy(() => import('../components/SuggestGrapesModal').then(m => ({ default: m.SuggestGrapesModal })));
const RecommendWineModal = lazy(() => import('../components/RecommendWineModal'));
const AddMoreBottlesModal = lazy(() => import('../components/AddMoreBottlesModal'));

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
  const [currentRelease, setCurrentRelease] = useState(null);
  const [rates, setRates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [consumeOpen, setConsumeOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [bdMoreOpen, setBdMoreOpen] = useState(false); // ⋮ overflow (Move, Added by mistake)
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const [mistakeOpen, setMistakeOpen] = useState(false);
  const [mistakeBusy, setMistakeBusy] = useState(false);
  const [suggestGrapesOpen, setSuggestGrapesOpen] = useState(false);
  const [addMoreOpen, setAddMoreOpen] = useState(false);
  const [addMoreMsg, setAddMoreMsg] = useState(null); // success banner after "Add more bottles"
  const [reportWineOpen, setReportWineOpen] = useState(false);
  const [reportDefaultReason, setReportDefaultReason] = useState(null);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [journalPromptOpen, setJournalPromptOpen] = useState(false);
  const [openPickerOpen, setOpenPickerOpen] = useState(false);
  const [openingMethod, setOpeningMethod] = useState('coravin');
  const [openingBusy, setOpeningBusy] = useState(false);
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
        setCurrentRelease(data.currentRelease || null);
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
        // Fetch community reviews for this wine. Pass the vintage explicitly —
        // this closure still sees the pre-setBottle (null) state, so reading
        // `bottle?.vintage` here would silently drop the default
        // "this vintage" filter on the initial load.
        const wineObj = data.bottle?.wineDefinition;
        if (wineObj?._id) {
          fetchWineReviews(wineObj._id, { bottleVintage: data.bottle.vintage });
          if (wineObj.communityRating?.reviewCount > 0) {
            setCommunityRating(wineObj.communityRating);
          }
        }
        // Fetch the sommelier maturity profile. NV bottles (non-vintage
        // Champagne / Cap Classique blends) get a profile too — somms can set a
        // drink window for them — so we fetch it for NV as well; only truly
        // unknown vintages are skipped. Price history stays vintage-specific.
        const wine = data.bottle?.wineDefinition;
        const vintage = data.bottle?.vintage;
        if (wine?._id && vintage && vintage !== 'Unknown') {
          fetchVintageProfile(wine._id, vintage);
          if (vintage !== 'NV') {
            fetchPriceHistory(wine._id, vintage);
            fetchRates().then(r => { if (r) setRates(r); });
          }
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
      const bottleVintage = opts.bottleVintage ?? bottle?.vintage;

      const params = new URLSearchParams();
      params.set('limit', '10');
      params.set('page', String(page));
      params.set('audience', audience);

      if (vintageFilter === 'this' && bottleVintage) {
        params.set('vintage', bottleVintage);
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

  const handleMistakeConfirm = async () => {
    if (mistakeBusy) return;
    setMistakeBusy(true);
    try {
      const res = await undoBottle(apiFetch, bottleId);
      if (res.ok) {
        navigate(`/cellars/${cellarId}`);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || t('bottleDetail.mistakeError', 'Failed to remove bottle'));
        setMistakeBusy(false);
      }
    } catch {
      alert(t('bottleDetail.mistakeError', 'Failed to remove bottle'));
      setMistakeBusy(false);
    }
  };

  const handleOpenBottle = async () => {
    setOpeningBusy(true);
    try {
      const res = await openBottle(apiFetch, bottleId, openingMethod);
      const data = await res.json();
      if (res.ok) {
        setBottle(prev => ({
          ...prev,
          openedAt: data.bottle.openedAt,
          preservationMethod: data.bottle.preservationMethod,
          pours: data.bottle.pours,
        }));
      } else {
        setError(data.error || t('common.networkError'));
      }
    } catch {
      setError(t('common.networkError'));
    } finally {
      setOpeningBusy(false);
      setOpenPickerOpen(false);
    }
  };

  const handleConsumeConfirm = async (reason, note, rating, consumedRatingScale) => {
    try {
      const res = await consumeBottle(apiFetch, bottleId, { reason, note, rating, consumedRatingScale });
      const data = await res.json();
      if (res.ok) {
        // Prompt for journal entry if user hasn't opted out
        if (!journalPromptOptedOut() && reason === 'drank') {
          setConsumeOpen(false);
          setJournalPromptOpen(true);
        } else {
          navigate(`/cellars/${cellarId}`);
        }
      } else {
        // Close the modal so the inline error banner is visible behind it.
        setConsumeOpen(false);
        setError(data.error || t('bottleDetail.consumeError'));
      }
    } catch {
      setConsumeOpen(false);
      setError(t('common.networkError'));
    }
  };

  // Only replace the whole page when nothing has loaded yet; once the bottle
  // is loaded, action failures render as a dismissible inline banner instead.
  if (error && !bottle) return <div className="alert alert-error">{error}</div>;

  const wine = bottle?.wineDefinition;
  const isPending = !wine && !!bottle?.pendingWineRequest;
  const displayName = wine?.name || bottle?.pendingWineRequest?.wineName;
  const displayProducer = wine?.producer || bottle?.pendingWineRequest?.producer;
  const isConsumed = bottle?.status && bottle.status !== 'active';
  const canEdit = !isConsumed && (userRole === 'owner' || userRole === 'editor');
  const canEditConsumed = isConsumed && (userRole === 'owner' || userRole === 'editor');
  // v1: move only active bottles, and only between cellars you own.
  const canMove = !isConsumed && userRole === 'owner';

  // "Move back to cellar" (undo an accidental removal) — only for a bottle
  // consumed within the last 2 days. Matches the server-side restore window;
  // past it the button is hidden and the endpoint refuses.
  const RESTORE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
  const canRestore = canEditConsumed && bottle?.consumedAt &&
    (Date.now() - new Date(bottle.consumedAt).getTime()) <= RESTORE_WINDOW_MS;

  // Shared overflow-menu contents — same list used by the desktop header ⋮ and
  // the mobile bar ⋮, so these actions live in exactly one place and can never
  // drift between the page's two action surfaces.
  const overflowItems = (
    <>
      {/* "Add more bottles" — the support answer to "I added Qty 1, how do I
          make it 6?" without re-searching in Add Bottle (promised 2026-08-10).
          Needs a real registry wine to clone (pending-request bottles have
          none) and a non-demo account (POST /api/bottles is requireNonDemo,
          same gate that hides the Add Bottle form in the demo). */}
      {canEdit && wine && !user?.isDemo && (
        <button className="bd-overflow-item" role="menuitem" onClick={() => { setAddMoreOpen(true); setBdMoreOpen(false); }}>
          <span aria-hidden="true">➕</span> {t('bottleDetail.addMore.action', 'Add more bottles')}
        </button>
      )}
      {canMove && (
        <button className="bd-overflow-item" role="menuitem" onClick={() => { setMoveOpen(true); setBdMoreOpen(false); }}>
          <span aria-hidden="true">📦</span> {t('moveBottle.action')}
        </button>
      )}
      {canEdit && (
        <button className="bd-overflow-item bd-overflow-item--danger" role="menuitem" onClick={() => { setMistakeOpen(true); setBdMoreOpen(false); }}>
          <span aria-hidden="true">↩️</span> {t('bottleDetail.mistakeLink', 'Added by mistake?')}
        </button>
      )}
    </>
  );

  const handleMoved = () => {
    setMoveOpen(false);
    navigate(`/cellars/${cellarId}`); // stay with the source cellar — back to its list
  };

  const handleAddedMore = (n) => {
    setAddMoreOpen(false);
    setAddMoreMsg(t('bottleDetail.addMore.success', { count: n }));
    // Same refresh path every other mutation on this page uses (edit, open):
    // re-pull the bottle + its cellar/rack context after the cellar changed.
    fetchBottle();
  };

  const handleRestore = async () => {
    if (restoreBusy) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const res = await restoreBottle(apiFetch, bottleId);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        navigate(`/cellars/${cellarId}`); // back to the active cellar — the bottle is there now
      } else {
        setRestoreError(data.error || t('bottleDetail.restoreError', 'Could not move it back — try again'));
        setRestoreBusy(false);
      }
    } catch {
      setRestoreError(t('bottleDetail.restoreError', 'Could not move it back — try again'));
      setRestoreBusy(false);
    }
  };

  return (
    <div className="bottle-detail-page">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button
            type="button"
            className="btn btn-small btn-secondary"
            style={{ marginLeft: '0.75rem' }}
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      )}
      {/* Confirmation after "Add more bottles" — same dismissible-banner shape
          as the error banner above, since the modal is gone by the time the
          batch result matters. */}
      {addMoreMsg && (
        <div className="alert alert-success" role="status">
          {addMoreMsg}
          <button
            type="button"
            className="btn btn-small btn-secondary"
            style={{ marginLeft: '0.75rem' }}
            onClick={() => setAddMoreMsg(null)}
          >
            ✕
          </button>
        </div>
      )}
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
                  {!bottle?.openedAt && (
                    <button className="btn btn-secondary btn-small" onClick={() => setOpenPickerOpen(true)}>
                      🍷 <span className="bd-btn-label">{t('openBottle.openBtn', 'Open bottle…')}</span>
                    </button>
                  )}
                  <button className="btn btn-consume btn-small" onClick={() => setConsumeOpen(true)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2h8l4 10H4L8 2z"/><path d="M12 12v6"/><path d="M8 22h8"/></svg>
                    <span className="bd-btn-label">{t('bottleDetail.removeBottle')}</span>
                  </button>
                </>
              )}
              {/* Less-frequent actions (Add more, Move, Added by mistake) live
                  in the overflow — frequent actions stay visible, so the bar
                  fits on phones too */}
              {(canMove || canEdit) && (
                <div className="bd-overflow-wrap">
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => setBdMoreOpen(o => !o)}
                    aria-label={t('cellarDetail.moreActions')}
                    aria-haspopup="menu"
                    aria-expanded={bdMoreOpen}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                  </button>
                  {bdMoreOpen && (
                    <>
                      <div className="bd-overflow-backdrop" onClick={() => setBdMoreOpen(false)} aria-hidden="true" />
                      <div className="bd-overflow-menu" role="menu">
                        {overflowItems}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="loading">{t('bottleDetail.loadingBottle')}</div>
      ) : <>
      {/* ── Open-bottle (Coravin / preservation) status ── */}
      {bottle?.openedAt && !isConsumed && (
        <OpenBottlePanel
          bottle={bottle}
          canEdit={canEdit}
          onBottleChange={(patch) => setBottle(prev => ({ ...prev, ...patch }))}
          onFinish={() => setConsumeOpen(true)}
        />
      )}

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
                  url={`${SITE_URL}/wines/${wine.slug || wine._id}`}
                  onRecommend={() => setRecommendOpen(true)}
                  variant="icon"
                />
              )}
            </div>
            <p className="bd-producer">
              {/* A pending-identity wine has no producer yet. Say so plainly
                  rather than rendering a bare "· France": the owner otherwise
                  has no way to know their wine is awaiting curation, and won't
                  understand why it can't be found in search (audit L-3 + the
                  product finding). No action is required of them — promotion
                  is automatic — so this is a statement, not a prompt. */}
              {displayProducer || <em className="bd-producer-pending">{t('bottleDetail.producerPending')}</em>}
              {wine?.country?.name && <span className="bd-country">{displayProducer ? ' · ' : ' — '}{wine.country.name}</span>}
            </p>
            {wine?.type && (
              <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Curator owner-inquiry (content card — renders only when this
          wine has an open inquiry addressed to the viewer). Demo visitors are
          excluded: their ephemeral accounts can never respond (requireNonDemo)
          and the shop-window must not dead-end into a 403. ── */}
      {wine?._id && !user?.isDemo && <OwnerInquiryCard apiFetch={apiFetch} wineId={wine._id} />}

      {/* ── Consumption details (history bottles only) ── */}
      {isConsumed && (
        <ConsumedDetails bottle={bottle} canEdit={canEditConsumed} onUpdate={setBottle} />
      )}

      {/* Undo an accidental removal — only within the 2-day restore window */}
      {canRestore && (
        <div className="bd-restore-row">
          <button type="button" className="bd-restore-btn" onClick={handleRestore} disabled={restoreBusy}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/>
            </svg>
            {restoreBusy ? t('bottleDetail.restoring', 'Moving back…') : t('bottleDetail.restore', 'Move back to cellar')}
          </button>
          <span className="bd-restore-hint">{t('bottleDetail.restoreHint', 'Removed by mistake? Put it back as active (within 2 days).')}</span>
          {restoreError && <span className="bd-restore-error">{restoreError}</span>}
        </div>
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
          currentRelease={currentRelease}
          rates={rates}
          userCurrency={user?.preferences?.currency || 'USD'}
          canEdit={canEdit}
          hasImage={!!(defaultImage || pendingImage || bottle.wineDefinition?.image)}
          onEdit={() => setEditing(true)}
          onSuggestGrapes={() => setSuggestGrapesOpen(true)}
          onRemove={() => setConsumeOpen(true)}
          onReportWine={(reason) => { setReportWineOpen(true); setReportDefaultReason(typeof reason === 'string' ? reason : null); }}
        />
      )}

      {/* ── Personal typed key/value data (#986) — content card, renders once.
          Demo visitors are excluded: writes are requireNonDemo and their
          ephemeral accounts would orphan shared-visible rows. ── */}
      {!user?.isDemo && (
        <PersonalDataCard apiFetch={apiFetch} bottleId={bottleId} currentUserId={user?.id} wineId={wine?._id} />
      )}

      {/* ── AI tasting profile (generated, vintage-neutral) ── */}
      {wine?.aiProfile?.description && (
        <div className="bd-ai-profile card">
          <div className="bd-ai-profile__header">
            <h2>{t('bottleDetail.tastingProfile', 'Tasting profile')}</h2>
            {/* Provenance is load-bearing (#985): never present AI-generated
                profile text as established fact. */}
            {wine.aiProfile.source === 'curator' ? (
              <span className="bd-ai-tag bd-ai-tag--curator" title={t('bottleDetail.provenanceCuratorTitle', 'A sommelier has verified this profile')}>
                {t('bottleDetail.provenanceCurator', 'Curator-verified')}
              </span>
            ) : (
              <span className="bd-ai-tag" title={t('bottleDetail.provenanceAiTitle', 'Written by AI from the wine’s identity — a starting point, not a fact')}>
                {t('bottleDetail.provenanceAi', 'AI-generated')}
              </span>
            )}
          </div>

          {(() => {
            const ap = wine.aiProfile;
            const structure = [
              ap.body && `${ap.body}-bodied`,
              ap.tannin && `${ap.tannin} tannin`,
              ap.acidity && `${ap.acidity} acidity`,
              ap.sweetness,
            ].filter(Boolean);
            const flavours = ap.flavors || [];
            return (
              <>
                {structure.length > 0 && (
                  <div className="bd-ai-group">
                    <span className="bd-ai-group-label">{t('bottleDetail.structure', 'Structure')}</span>
                    <div className="bd-ai-chips">
                      {structure.map((c, i) => <span key={`s${i}`} className="bd-ai-chip bd-ai-chip--style">{c}</span>)}
                    </div>
                  </div>
                )}
                {flavours.length > 0 && (
                  <div className="bd-ai-group">
                    <span className="bd-ai-group-label">{t('bottleDetail.flavours', 'Flavours')}</span>
                    <div className="bd-ai-chips">
                      {flavours.map((f, i) => <span key={`f${i}`} className="bd-ai-chip">{f}</span>)}
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          <div className="bd-ai-prose">
            <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{wine.aiProfile.description}</ReactMarkdown>
          </div>

          {wine.aiProfile.foodPairings?.length > 0 && (
            <div className="bd-ai-pairings">
              <span className="bd-ai-pairings__label">{t('bottleDetail.pairsWith', 'Pairs with')}:</span>
              {wine.aiProfile.foodPairings.join(' · ')}
            </div>
          )}

          <div className="bd-report-wine">
            <button
              type="button"
              className="btn-report-wine"
              onClick={() => { setReportDefaultReason('wrong_tasting_profile'); setReportWineOpen(true); }}
            >
              {t('bottleDetail.reportTastingProfile', 'Report tasting profile')}
            </button>
          </div>
        </div>
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
              <ReviewCard
                key={review._id}
                review={review}
                showWine={false}
                onDelete={() => {
                  // Same refresh as after saving a review: refetch the list and
                  // drop the (now stale) community aggregate.
                  fetchWineReviews(wine._id);
                  setCommunityRating(null);
                }}
              />
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
            {t('bottleDetail.editDetailsShort')}
          </button>
          {/* Same visibility rule as the desktop header button — the mobile
              bar was missed when open-bottle tracking shipped (canEdit already
              excludes consumed bottles). */}
          {!bottle?.openedAt && (
            <button className="bd-mobile-action-btn bd-mobile-action-open" onClick={() => setOpenPickerOpen(true)}>
              <span aria-hidden="true">🍷</span>
              {t('openBottle.openBtnShort', 'Open')}
            </button>
          )}
          <button className="bd-mobile-action-btn bd-mobile-action-consume" onClick={() => setConsumeOpen(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2h8l4 10H4L8 2z"/><path d="M12 12v6"/><path d="M8 22h8"/></svg>
            {t('bottleDetail.removeBottleShort')}
          </button>
          {/* Less-frequent actions (Add more, Move, Added by mistake) — keeps
              the bar to three visible buttons so nothing gets cut off on
              narrow screens */}
          {(canMove || canEdit) && (
            <div className="bd-overflow-wrap bd-overflow-wrap--mobile">
              <button className="bd-mobile-action-btn bd-mobile-action-more" onClick={() => setBdMoreOpen(o => !o)} aria-label={t('cellarDetail.moreActions')} aria-haspopup="menu" aria-expanded={bdMoreOpen}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                {t('bottleDetail.moreShort', 'More')}
              </button>
              {bdMoreOpen && (
                <>
                  <div className="bd-overflow-backdrop" onClick={() => setBdMoreOpen(false)} aria-hidden="true" />
                  <div className="bd-overflow-menu bd-overflow-menu--up" role="menu">
                    {overflowItems}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {mistakeOpen && (
        <div className="modal-overlay" onClick={() => !mistakeBusy && setMistakeOpen(false)}>
          <DialogBox
            className="modal-box"
            onClick={e => e.stopPropagation()}
            onClose={() => !mistakeBusy && setMistakeOpen(false)}
            label={t('bottleDetail.mistakeTitle', 'Remove as a mistake?')}
          >
            <h2>{t('bottleDetail.mistakeTitle', 'Remove as a mistake?')}</h2>
            <p>{t('bottleDetail.mistakeBody', 'This will permanently remove the bottle as if it had never been added. It will not appear in your stats, history, or search. This cannot be undone.')}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setMistakeOpen(false)}
                disabled={mistakeBusy}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleMistakeConfirm}
                disabled={mistakeBusy}
              >
                {mistakeBusy
                  ? t('bottleDetail.mistakeRemoving', 'Removing…')
                  : t('bottleDetail.mistakeConfirm', 'Yes, remove it')}
              </button>
            </div>
          </DialogBox>
        </div>
      )}

      {/* ── Cellar journey: discreet history footer (added → moved → consumed) ── */}
      {!editing && <BottleJourney bottle={bottle} />}

      <Suspense fallback={null}>
        {consumeOpen && (
          <ConsumeModal
            wineName={displayName}
            defaultRatingScale={user?.preferences?.ratingScale || '5'}
            reservationText={isReserved(bottle) ? reservationSummary(bottle, t) : undefined}
            onConfirm={handleConsumeConfirm}
            onCancel={() => setConsumeOpen(false)}
          />
        )}

        {moveOpen && bottle && (
          <MoveBottleModal
            bottleId={bottle._id}
            currentCellarId={cellarId}
            wineLabel={displayName}
            onClose={() => setMoveOpen(false)}
            onMoved={handleMoved}
          />
        )}

        {suggestGrapesOpen && (
          <SuggestGrapesModal
            wine={wine}
            onClose={() => setSuggestGrapesOpen(false)}
          />
        )}

        {addMoreOpen && bottle && (
          <AddMoreBottlesModal
            bottle={bottle}
            onClose={() => setAddMoreOpen(false)}
            onAdded={handleAddedMore}
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

        {journalPromptOpen && (
          <JournalPrompt
            bottle={bottle}
            onDone={() => { setJournalPromptOpen(false); navigate(`/cellars/${cellarId}`); }}
          />
        )}

        {openPickerOpen && (
          <div className="modal-overlay" onClick={() => !openingBusy && setOpenPickerOpen(false)}>
            <DialogBox
              className="modal-box"
              onClick={e => e.stopPropagation()}
              onClose={() => !openingBusy && setOpenPickerOpen(false)}
              label={t('openBottle.pickerTitle', 'Open this bottle')}
            >
              <h2>{t('openBottle.pickerTitle', 'Open this bottle')}</h2>
              <p>{t('openBottle.pickerText', 'How will you preserve it? This sets the drink-by window — the bottle stays in your cellar until you finish it.')}</p>
              <div className="bd-open-methods">
                {PRESERVATION_METHODS.map(m => (
                  <label key={m.id} className={`bd-open-method ${openingMethod === m.id ? 'active' : ''}`}>
                    <input
                      type="radio"
                      name="preservation"
                      value={m.id}
                      checked={openingMethod === m.id}
                      onChange={() => setOpeningMethod(m.id)}
                    />
                    <span>
                      <strong>{t(`openBottle.method.${m.id}`, m.id)}</strong>
                      <small>{t('openBottle.freshness', 'about {{days}} days', { days: m.freshnessDays })}</small>
                    </span>
                  </label>
                ))}
              </div>
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={() => setOpenPickerOpen(false)} disabled={openingBusy}>
                  {t('common.cancel')}
                </button>
                <button className="btn btn-primary" disabled={openingBusy} onClick={handleOpenBottle}>
                  {openingBusy ? t('common.saving', 'Saving...') : t('openBottle.confirmBtn', 'Open bottle')}
                </button>
              </div>
            </DialogBox>
          </div>
        )}
      </Suspense>
    </div>
  );
}


export default BottleDetail;
