import { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { useParams, Link } from 'react-router-dom';
import BottleUndoNotice, { bottleNoticeName } from '../components/BottleUndoNotice';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { useFeature } from '../utils/featureFlags';
import { getCellarVintage } from '../api/cellars';
import { getBottle } from '../api/bottles';
import { lookupMaturityProfile, lookupPriceHistory } from '../api/somm';
import AuthImage from '../components/AuthImage';
import BottlePlaceholder from '../components/BottlePlaceholder';
import CollapsibleBlock, { CollapseToggle } from '../components/CollapsibleBlock';
import { useCollapsedBlocks } from '../utils/collapsedBlocks';
import BetaBadge from '../components/BetaBadge';
import Modal from '../components/Modal';
import CellarPageHeader from '../components/CellarPageHeader';
import MaturityPhaseTable from '../components/bottle/MaturityPhaseTable';
import LotHistory from '../components/bottle/LotHistory';
import PersonalDataCard from '../components/bottle/PersonalDataCard';
import TastingProfileCard from '../components/bottle/TastingProfileCard';
import WineRecordSection from '../components/bottle/WineRecordSection';
import WineReviewsCard from '../components/bottle/WineReviewsCard';
import OwnerInquiryCard from '../components/bottle/OwnerInquiryCard';
import PriceHistoryTimeline from '../components/bottle/PriceHistoryTimeline';
import PriceTrackingToggle from '../components/bottle/PriceTrackingToggle';
import { fetchRates } from '../utils/currency';
import JournalPrompt, { journalPromptOptedOut } from '../components/JournalPrompt';
import { getMaturityStatus } from '../utils/drinkStatus';
import { bottleAnchorYear } from '../utils/maturityUtils';
import { totalsByCurrency } from '../utils/onOrder';
import { isReserved, reservationSummary } from '../utils/reservation';
import { glassesLeft, daysLeft, freshnessStatus } from '../utils/openBottle';
import { swatchType, wineTypeLabel } from '../utils/wineColour';
import { bottleSizeLabel, DEFAULT_SIZE } from '../config/bottleSizes';
import { sharedBarcode, vintageBarcodeTargets } from '../utils/barcode';
import { slotLabel } from '../utils/slotLabel';
import './CellarDetail.css';
import './BottleDetail.css';
import './CellarVintage.css';
import './CellarVintageBeta.css';

const DrinkOneModal = lazy(() => import('../components/DrinkOneModal'));
const AddToPickListModal = lazy(() => import('../components/AddToPickListModal'));
const EditVintageModal = lazy(() => import('../components/EditVintageModal'));
const AddMoreBottlesModal = lazy(() => import('../components/AddMoreBottlesModal'));
const ReportWineModal = lazy(() => import('../components/ReportWineModal'));
const RecommendWineModal = lazy(() => import('../components/RecommendWineModal'));
const BarcodeScanModal = lazy(() => import('../components/BarcodeScanModal'));
const ImageGallery = lazy(() => import('../components/ImageGallery'));
const ImageUpload = lazy(() => import('../components/ImageUpload'));

const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';

// More bottles than this and the list starts folded under its stock line.
const FOLD_BOTTLES_OVER = 6;

// The router hands the vintage over decoded already: a second decode is a
// no-op for an ordinary vintage, and must not throw on a lone '%' in an
// imported one.
const safeDecode = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/**
 * One wine and vintage in a cellar — the EARLY-ACCESS layout (feature flag
 * 'vintagePage', backend config/featureFlags). The same page whether the
 * cellar holds one bottle of the vintage or forty, reached by tapping any
 * entry in the cellar list, and always in the same order: the wine, the
 * vintage, the bottles — with Drink, Edit vintage and Add in a bar that
 * stays in reach (support ticket 2026-10-09, follow-up).
 *
 * The classic layout (CellarVintage.js) stays for everyone else until the
 * flag goes to everyone; then this one replaces it. Same data (GET
 * /api/cellars/:id/vintages/…), and every save goes through the routes the
 * other screens use (bulk update, consume, add bottles), so switching early
 * access off loses nothing.
 */
function CellarVintageBeta() {
  const { t, i18n } = useTranslation();
  const { id, wineId, vintage: vintageParam } = useParams();
  const { apiFetch, user } = useAuth();
  // Blocks the member folded away, remembered on the account (beta feedback
  // 2026-10-12): the three sections, and the cards with a title of their own.
  const { isCollapsed, toggle, expand } = useCollapsedBlocks();
  const blockProps = (blockId, label) => ({ id: blockId, label, collapsed: isCollapsed(blockId), onToggle: () => toggle(blockId) });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [modal, setModal] = useState(null); // 'drink' | 'pickList' | 'edit' | 'add' | 'report' | 'reportWine' | 'recommend' | 'barcode'
  const [priceHistory, setPriceHistory] = useState(null);
  const [rates, setRates] = useState(null);
  const [galleryEmpty, setGalleryEmpty] = useState(false);
  // A hero photo that fails to load shows the drawn bottle, not a blank;
  // remembered by address, so a new photo is tried again.
  const [failedHero, setFailedHero] = useState(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const galleryRef = useRef(null);
  const [addTemplate, setAddTemplate] = useState(null);
  const [moreOpen, setMoreOpen] = useState(null); // 'top' | 'bar'
  const [suggestSignal, setSuggestSignal] = useState(0);
  const [journalBottle, setJournalBottle] = useState(null);
  const [notice, setNotice] = useState(null);
  // The bottle just taken out here, said with Undo (components/BottleUndoNotice).
  // It belongs to this vintage and this moment: another vintage, or another
  // notice taking its place, ends it.
  const [drunkNotice, setDrunkNotice] = useState(null);
  useEffect(() => { setDrunkNotice(null); }, [id, wineId, vintageParam]);
  useEffect(() => { if (notice) setDrunkNotice(null); }, [notice]);

  const vintage = safeDecode(vintageParam || 'NV');
  const pagePath = `/cellars/${id}/vintages/${wineId}/${encodeURIComponent(vintage)}`;

  // Whether a long list is unfolded, remembered for this page in this tab:
  // back from one of its bottles, the list is as the user left it.
  const foldKey = `cvb-unfolded:${pagePath}`;
  const [showAllBottles, setShowAllBottlesState] = useState(() => {
    try { return window.sessionStorage.getItem(foldKey) === '1'; } catch { return false; }
  });
  const setShowAllBottles = (open) => {
    setShowAllBottlesState(open);
    try {
      if (open) window.sessionStorage.setItem(foldKey, '1');
      else window.sessionStorage.removeItem(foldKey);
    } catch { /* storage off: the list just folds again next time */ }
  };

  const load = async () => {
    try {
      const res = await getCellarVintage(apiFetch, id, wineId, vintage);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || t('cellarVintage.loadFailed', 'Could not load this vintage.')); return; }
      setData(body);
    } catch {
      setError(t('cellarVintage.loadFailed', 'Could not load this vintage.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id, wineId, vintage]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sommelier window for this vintage, as on the bottle page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await lookupMaturityProfile(apiFetch, wineId, vintage);
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setProfile(res.ok ? body.profile || null : null);
      } catch {
        if (!cancelled) setProfile(null);
      } finally {
        if (!cancelled) setProfileLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, wineId, vintage]);

  // What the vintage is worth on the market, as on the bottle page (not for
  // NV or an unknown year), with the rates to show it in the reader's currency.
  useEffect(() => {
    if (!vintage || vintage === 'NV' || vintage === 'Unknown') { setPriceHistory(null); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const res = await lookupPriceHistory(apiFetch, wineId, vintage);
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setPriceHistory(res.ok ? body.history || [] : []);
      } catch {
        if (!cancelled) setPriceHistory([]);
      }
    })();
    fetchRates().then((r) => { if (!cancelled && r) setRates(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [apiFetch, wineId, vintage]);

  const bottles = data?.bottles || [];
  const wine = data?.wine || null;
  const cellar = data?.cellar || null;
  const canEdit = !!cellar && ['owner', 'editor'].includes(cellar.userRole);
  // Early access (flag pickLists): put bottles of this wine and year on a
  // pick list from here, not only from each bottle's own page (beta feedback
  // 2026-10-14). Same rule as the bottle page: an owner or editor, bottles
  // still in the cellar.
  const pickListsOn = useFeature('pickLists');
  const pickable = bottles.filter((b) => b.status === 'active');
  const canPickList = pickListsOn && canEdit && pickable.length > 0;
  const canSuggest = !!wine && !user?.isDemo && wine.draft !== true;
  const canAdd = canEdit && !!wine && !user?.isDemo && (bottles.length > 0 || !!data?.historyBottleId);
  const first = bottles[0] || null;
  const title = wine ? `${wine.name} ${vintage}` : t('cellarVintage.title', 'Vintage');
  // Photos are filed under a bottle and its vintage (BottleImage.vintage), so
  // a photo added here goes through a bottle of this vintage — one still in
  // the cellar, else the last one drunk — and shows on every bottle of it.
  const photoBottleId = first?._id || data?.historyBottleId || null;
  const canPhoto = canEdit && !user?.isDemo && !!wine && !!photoBottleId;
  // The gallery goes through that bottle: when it changes (the first bottle
  // drunk), look again rather than keep the last one's "no photos".
  useEffect(() => { setGalleryEmpty(false); }, [photoBottleId]);
  // The photo window closes before a cut-out may be done (the upload's own
  // "processed" callback dies with it): look again now and a little later.
  const photoTimers = useRef([]);
  useEffect(() => () => photoTimers.current.forEach(clearTimeout), []);
  const refreshPhotos = () => { setGalleryEmpty(false); galleryRef.current?.refresh(); };
  const closePhoto = () => {
    setPhotoOpen(false);
    refreshPhotos();
    load();
    photoTimers.current.forEach(clearTimeout);
    photoTimers.current = [6000, 20000].map((ms) => setTimeout(refreshPhotos, ms));
  };
  // A barcode belongs to the product: it goes on the bottles of the
  // vintage's main size that have no code of their own (utils/barcode).
  const barcodeTargets = useMemo(() => vintageBarcodeTargets(bottles), [bottles]);
  const canBarcode = canEdit && !user?.isDemo && barcodeTargets.length > 0;
  // A private draft is not registry content: it is never reported,
  // recommended or price-tracked (the server refuses all three).
  const isDraft = wine?.draft === true;
  const canReport = !!wine && !user?.isDemo && !isDraft;
  const canTrackPrice = !user?.isDemo && !isDraft && !!photoBottleId;

  // Where the bottles sit, as one line per rack: "Left wall · slots 3, 7".
  const placements = useMemo(() => {
    const byRack = new Map();
    for (const b of bottles) {
      if (!b.rackInfo) continue;
      const key = String(b.rackInfo.rackId);
      if (!byRack.has(key)) byRack.set(key, { id: key, name: b.rackInfo.rackName, positions: [] });
      if (b.rackInfo.position != null) byRack.get(key).positions.push(b.rackInfo.position);
    }
    return [...byRack.values()].map((r) => ({ ...r, positions: r.positions.sort((a, b) => a - b) }));
  }, [bottles]);
  const unplaced = bottles.filter((b) => !b.rackInfo).length;
  const totals = useMemo(() => totalsByCurrency(bottles), [bottles]);
  const totalText = totals
    .map(({ currency, total }) => `${total.toLocaleString(i18n.language, { maximumFractionDigits: 2 })} ${currency}`)
    .join(' + ');
  const pricedCount = bottles.filter((b) => Number(b.price) > 0).length;

  // The stock line at the head of the bottle list: where they sit, what is
  // on order or was drunk, what was paid — in the singular for one ("slot
  // 147", "Paid", beta feedback 2026-10-10).
  const stockItems = [
    ...placements.map((r) => (
      <span key={`rack-${r.id}`} className="cvb-summary-item">
        <span aria-hidden="true">📍</span> {r.positions.length
          ? t('cellarVintageBeta.rackSlots', { rack: r.name, slots: r.positions.join(', '), count: r.positions.length })
          : r.name}
      </span>
    )),
    placements.length > 0 && unplaced > 0 && (
      <span key="unplaced" className="cvb-summary-item">{t('cellarVintage.unplaced', { count: unplaced })}</span>
    ),
    data?.onOrderCount > 0 && (
      <Link key="on-order" to={`/cellars/${id}/on-order`} className="cvb-summary-item">{t('cellarVintage.onOrder', { count: data.onOrderCount })}</Link>
    ),
    data?.consumedCount > 0 && (
      <Link key="drunk" to={`/cellars/${id}/history`} className="cvb-summary-item">{t('cellarVintage.drunk', { count: data.consumedCount })}</Link>
    ),
    totalText && (
      <span key="paid" className="cvb-summary-item">{t('cellarVintageBeta.paid', { amount: totalText, count: pricedCount })}</span>
    ),
  ].filter(Boolean);
  const foldable = bottles.length > FOLD_BOTTLES_OVER;
  const bottlesFolded = foldable && !showAllBottles;

  // What the bottles share, per field: the common value, nothing at all, or
  // values that differ — the vintage section says which.
  const sharedState = (field) => {
    const values = new Set(bottles.map((b) => (filled(b[field]) ? String(b[field]).trim() : '')));
    if (values.size === 1) {
      const [only] = [...values];
      return only ? { kind: 'shared', value: only } : { kind: 'none' };
    }
    return { kind: 'differs' };
  };
  const windowFields = ['drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil'].map(sharedState);
  const windowDiffers = windowFields.some((s) => s.kind === 'differs');
  const [from, to, peakFrom, peakUntil] = windowFields.map((s) => (s.kind === 'shared' ? s.value : null));
  const notes = sharedState('notes');

  const anchorYear = bottleAnchorYear(first);
  const maturityStatus = profile ? getMaturityStatus(profile, anchorYear) : null;
  const profileReviewed = profile?.status === 'reviewed';

  // Hero, in the cards' order: a chosen or own photo of this vintage, the
  // vintage's official photo, the wine's image, then an own photo of another year.
  const heroOwn = first?.defaultImageUrl || first?.pendingImageUrl || null;
  const heroRegistry = first?.vintageImageUrl || wine?.image || null;
  const heroSrc = heroOwn || heroRegistry || first?.otherVintageImageUrl || null;
  const heroCredit = heroOwn || !heroRegistry ? null : (first?.vintageImageUrl ? first?.vintageImageCredit : wine?.imageCredit);

  const handleDrunk = (bottle, reason) => {
    setModal(null);
    // The line now offers Undo (the 2-day restore), not just "Logged".
    setNotice(null);
    setDrunkNotice({ kind: 'consumed', reason, bottleId: bottle._id, name: bottleNoticeName({ ...bottle, wineDefinition: wine || bottle.wineDefinition }), at: Date.now() });
    if (reason === 'drank' && !journalPromptOptedOut()) setJournalBottle(bottle);
    else load();
  };

  // "Add": more of this vintage, copied from a bottle of it — one still in
  // the cellar, or else the last one drunk (buying the same vintage again).
  const openAdd = async () => {
    setMoreOpen(null);
    if (first) { setAddTemplate(first); setModal('add'); return; }
    try {
      const res = await getBottle(apiFetch, data.historyBottleId);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.bottle) throw new Error();
      setAddTemplate(body.bottle);
      setModal('add');
    } catch {
      setError(t('cellarVintageBeta.addFailed', 'Could not start adding a bottle. Please try again.'));
    }
  };

  const suggestFix = () => {
    setMoreOpen(null);
    // The form opens in the wine record: unfold it if the member folded it.
    expand('vintage.wine', 'vintage.record');
    setSuggestSignal((n) => n + 1);
  };

  const pick = (next) => () => { setMoreOpen(null); setModal(next); };
  const moreItems = (
    <>
      {canPickList && (
        <button type="button" className="bd-overflow-item" role="menuitem" onClick={pick('pickList')}>
          <span aria-hidden="true">📍</span> {t('pickLists.addAction', 'Add to pick list')}
        </button>
      )}
      {canPhoto && (
        <button type="button" className="bd-overflow-item" role="menuitem" onClick={() => { setMoreOpen(null); setPhotoOpen(true); }}>
          <span aria-hidden="true">🖼️</span> {t('cellarVintageBeta.addPhoto', 'Add a photo of this vintage')}
        </button>
      )}
      {canBarcode && (
        <button type="button" className="bd-overflow-item" role="menuitem" onClick={pick('barcode')}>
          <span aria-hidden="true">📷</span> {sharedBarcode(barcodeTargets) ? t('barcodeScan.titleChange', 'Change barcode') : t('barcodeScan.title', 'Add barcode')}
        </button>
      )}
      {canSuggest && (
        <button type="button" className="bd-overflow-item" role="menuitem" onClick={suggestFix}>
          <span aria-hidden="true">✏️</span> {t('cellarVintageBeta.editWine', 'Suggest a fix to the wine')}
        </button>
      )}
      {canReport && (
        <button type="button" className="bd-overflow-item" role="menuitem" onClick={pick('reportWine')}>
          <span aria-hidden="true">⚑</span> {t('cellarVintageBeta.reportWine', 'Report a problem with this wine')}
        </button>
      )}
      {canReport && (
        <button type="button" className="bd-overflow-item" role="menuitem" onClick={pick('recommend')}>
          <span aria-hidden="true">💌</span> {t('cellarVintageBeta.recommend', 'Recommend to a friend')}
        </button>
      )}
      {wine?.slug && (
        <Link to={`/wines/${wine.slug}`} className="bd-overflow-item" role="menuitem" onClick={() => setMoreOpen(null)}>
          <span aria-hidden="true">📖</span> {t('cellarVintageBeta.openRegistry', 'Open in the shared registry')}
        </Link>
      )}
    </>
  );
  const hasMore = canPickList || canPhoto || canBarcode || canSuggest || canReport || !!wine?.slug;
  const canDrink = canEdit && bottles.length > 0;
  const canEditVintage = canEdit && bottles.length > 0;
  const hasActions = canDrink || canEditVintage || canAdd || hasMore;

  const moreMenu = (where) => hasMore && (
    <div className={`bd-overflow-wrap${where === 'bar' ? ' bd-overflow-wrap--mobile' : ''}`}>
      <button
        type="button"
        className={where === 'bar' ? 'bd-mobile-action-btn bd-mobile-action-more' : 'btn btn-secondary btn-small'}
        onClick={() => setMoreOpen((o) => (o === where ? null : where))}
        aria-label={t('cellarDetail.moreActions')}
        aria-haspopup="menu"
        aria-expanded={moreOpen === where}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </button>
      {moreOpen === where && (
        <>
          <div className="bd-overflow-backdrop" onClick={() => setMoreOpen(null)} aria-hidden="true" />
          <div className={`bd-overflow-menu${where === 'bar' ? ' bd-overflow-menu--up' : ''}`} role="menu">{moreItems}</div>
        </>
      )}
    </div>
  );

  // Desktop: the actions next to the title. Phone: the same in a fixed bar
  // at the bottom (the bottle page's two surfaces).
  const headerActions = !loading && data && hasActions ? (
    <div className="bd-header-actions">
      {canDrink && (
        <button type="button" className="btn btn-consume btn-small" onClick={() => setModal('drink')}>
          <span aria-hidden="true">🍷</span> {t('cellarVintageBeta.drink', 'Drink a bottle')}
        </button>
      )}
      {canEditVintage && (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setModal('edit')}>
          {t('cellarVintageBeta.editVintage', 'Edit vintage')}
        </button>
      )}
      {canAdd && (
        <button type="button" className="btn btn-secondary btn-small" onClick={openAdd}>
          <span aria-hidden="true">➕</span> {t('cellarVintageBeta.add', 'Add bottle')}
        </button>
      )}
      {moreMenu('top')}
    </div>
  ) : null;

  return (
    <div className="cellar-detail-page cellar-vintage-page cvb-page">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button type="button" className="btn btn-small btn-secondary" style={{ marginLeft: '0.75rem' }} onClick={() => setError(null)}>✕</button>
        </div>
      )}
      <CellarPageHeader
        backTo={`/cellars/${id}`}
        backLabel={t('history.backTo', { cellarName: cellar?.name || '…' })}
        title={title}
        loading={loading}
        userColor={cellar?.userColor}
        // Which page this is, at a glance: the vintage, not one bottle — the
        // bottle page carries the matching "Bottle" label.
        subtitle={cellar ? (
          <span className="page-kind-line">
            <span className="page-kind">{t('cellarVintageBeta.kind', 'Vintage')}</span>
            {bottles.length > 0
              ? t('cellarVintageBeta.kindLine', { count: bottles.length, cellar: cellar.name })
              : t('cellarVintageBeta.kindLineNone', 'This wine and year · none left in {{cellar}}', { cellar: cellar.name })}
          </span>
        ) : null}
        actions={headerActions}
      />

      {/* No cellar menu here: it belongs to the cellar, not to the wine, and
          "Back to the cellar" above already leads there (beta feedback
          2026-10-10). */}
      <BetaBadge feature="vintagePage" note={t('cellarVintageBeta.betaNote', 'A new layout for this page, in early access.')} />

      {notice && (
        <div className="alert alert-success cellar-vintage-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="cellar-vintage-notice-close" aria-label={t('common.close', 'Close')} onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
      {drunkNotice && (
        <BottleUndoNotice
          key={`${drunkNotice.bottleId}:${drunkNotice.at}`}
          floating
          notice={drunkNotice}
          cellarId={id}
          onUndone={load}
          onDismiss={() => setDrunkNotice(null)}
        />
      )}

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : !data ? null : (
        <>
          <div className="cvb-grid">
            {/* 1. The wine: who made it, where, the grapes, the description. */}
            <section className="cvb-col" aria-labelledby="cvb-wine-title">
              <div className="cvb-h2-row">
                <h2 id="cvb-wine-title" className="cvb-h2">{t('cellarVintageBeta.wineTitle', 'The wine')}</h2>
                <CollapseToggle
                  collapsed={isCollapsed('vintage.wine')}
                  onToggle={() => toggle('vintage.wine')}
                  label={t('cellarVintageBeta.wineTitle', 'The wine')}
                  controls="cvb-wine-body"
                />
              </div>
              <div id="cvb-wine-body" className="cvb-section-body" hidden={isCollapsed('vintage.wine')}>
              {wine && !user?.isDemo && <OwnerInquiryCard apiFetch={apiFetch} wineId={wine._id} />}
              {wine && (
                <div className="card cvb-wine">
                  {/* This vintage's photos (the bottle page's gallery, through a
                      bottle of the vintage), else the hero in the cards' order;
                      and "Add a photo" for whoever looks after the bottles. */}
                  <div className="cvb-photo">
                    {photoBottleId && !galleryEmpty ? (
                      <div className="cvb-gallery">
                        <Suspense fallback={null}>
                          <ImageGallery ref={galleryRef} bottleId={photoBottleId} vintage={vintage} vintageScope size="medium" onEmpty={() => setGalleryEmpty(true)} />
                        </Suspense>
                      </div>
                    ) : heroSrc && heroSrc !== failedHero ? (
                      <div className="cvb-hero">
                        <AuthImage src={heroSrc} alt={title} className="cvb-hero-img" onError={() => setFailedHero(heroSrc)} />
                        {heroCredit && <span className="bd-wine-image-credit">{heroCredit}</span>}
                      </div>
                    ) : (
                      // No photo yet: a drawn bottle with the wine's name on its
                      // label, as on the bottle page.
                      <div className="bd-wine-placeholder bd-wine-placeholder--drawn">
                        <BottlePlaceholder wine={wine} vintage={vintage} title={title} />
                      </div>
                    )}
                    {canPhoto && (
                      <button type="button" className="btn btn-secondary btn-small cvb-add-photo" onClick={() => setPhotoOpen(true)}>
                        <span aria-hidden="true">🖼️</span> {t('cellarVintageBeta.addPhotoShort', 'Add a photo')}
                      </button>
                    )}
                  </div>
                  <div className="cvb-wine-meta">
                    <div className="cvb-wine-name">{wine.name}</div>
                    <div className="cvb-wine-line">
                      {[wine.producer, wine.region?.name, wine.country?.name].filter(Boolean).join(' · ')}
                    </div>
                    {wine.type && <span className={`wine-type-pill ${swatchType(wine)}`}>{wineTypeLabel(wine, t)}</span>}
                  </div>
                </div>
              )}
              <CollapsibleBlock {...blockProps('vintage.tasting', t('bottleDetail.tastingProfile', 'Tasting profile'))}>
                <TastingProfileCard wine={wine} onReport={canSuggest ? () => setModal('report') : undefined} />
              </CollapsibleBlock>
              {wine && (
                <CollapsibleBlock nested {...blockProps('vintage.record', t('wineRecord.title', 'Wine record'))}>
                  <section className="card cellar-vintage-section">
                    <WineRecordSection
                      wine={wine}
                      vintage={vintage}
                      canSuggest={canSuggest}
                      apiFetch={apiFetch}
                      promptMissingGrapes={canEdit}
                      suggestSignal={suggestSignal}
                    />
                  </section>
                </CollapsibleBlock>
              )}
              </div>
            </section>

            <div className="cvb-col">
              {/* 2. The vintage: the sommelier's window, what you keep for it. */}
              <section aria-labelledby="cvb-vintage-title">
                <div className="cvb-h2-row">
                  <h2 id="cvb-vintage-title" className="cvb-h2">{t('cellarVintageBeta.vintageTitle', 'This vintage: {{vintage}}', { vintage })}</h2>
                  <CollapseToggle
                    collapsed={isCollapsed('vintage.vintage')}
                    onToggle={() => toggle('vintage.vintage')}
                    label={t('cellarVintageBeta.vintageTitle', 'This vintage: {{vintage}}', { vintage })}
                    controls="cvb-vintage-body"
                  />
                </div>
                <div id="cvb-vintage-body" className="cvb-section-body" hidden={isCollapsed('vintage.vintage')}>
                <div className="card cvb-vintage">
                  <div className="cvb-block">
                    <span className="bd-section-label">{t('bottleDetail.sommMaturity')}</span>
                    {!profileLoaded ? (
                      <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>
                    ) : !profileReviewed ? (
                      <div className="bd-maturity-pending">
                        <span className="maturity-badge maturity-badge--pending">{t('bottleDetail.awaitingSommelier')}</span>
                        <span className="bd-maturity-note">{t('bottleDetail.sommelierWillSet')}</span>
                      </div>
                    ) : (
                      <div className="bd-maturity-reviewed">
                        {maturityStatus && <span className={`maturity-badge maturity-badge--${maturityStatus.status}`}>{maturityStatus.label}</span>}
                        <MaturityPhaseTable profile={profile} anchorYear={anchorYear} />
                        {profile.sommNotes && <p className="bd-maturity-notes">{profile.sommNotes}</p>}
                      </div>
                    )}
                  </div>
                  <div className="cvb-block">
                    <span className="bd-section-label">{t('cellarVintage.yourWindow', 'Your drink window')}</span>
                    {bottles.length === 0 ? (
                      <span className="cvb-muted">{t('cellarVintageBeta.noBottlesForWindow', 'Kept on the bottles; none left in this cellar.')}</span>
                    ) : windowDiffers ? (
                      <span className="cvb-muted">{t('cellarVintageBeta.windowDiffers', 'Differs between the bottles. Edit vintage sets one for all of them.')}</span>
                    ) : from || to || peakFrom || peakUntil ? (
                      <span>
                        {from || to ? `${from || '…'}–${to || '…'}` : null}
                        {(peakFrom || peakUntil) && (
                          <span className="cellar-vintage-peak">{from || to ? ' · ' : ''}{t('cellarVintage.peak', 'peak {{range}}', { range: `${peakFrom || '…'}–${peakUntil || '…'}` })}</span>
                        )}
                      </span>
                    ) : (
                      <span className="cvb-muted">{t('cellarVintageBeta.notSet', 'Not set yet.')}</span>
                    )}
                  </div>
                  <div className="cvb-block">
                    <span className="bd-section-label">{t('common.notes')}</span>
                    {notes.kind === 'shared' ? (
                      <p className="cellar-vintage-notes">{notes.value}</p>
                    ) : notes.kind === 'differs' ? (
                      <span className="cvb-muted">
                        {t('cellarVintageBeta.notesDiffer', 'Each bottle has its own note: see the bottles below.')}
                        {/* The notes are on the rows: a folded list opens from here too. */}
                        {bottlesFolded && (
                          <>
                            {' '}
                            <button type="button" className="cvb-inline-link" onClick={() => setShowAllBottles(true)}>
                              {t('cellarVintageBeta.showBottles', { count: bottles.length })}
                            </button>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="cvb-muted">{t('cellarVintageBeta.noNotes', 'No notes yet.')}</span>
                    )}
                  </div>
                  {/* What the vintage is worth, as on the bottle page — and,
                      while nobody has priced it, the request to track it. */}
                  {vintage !== 'NV' && vintage !== 'Unknown' && priceHistory !== null && (priceHistory.length > 0 || canTrackPrice) && (
                    <div className="cvb-block">
                      <span className="bd-section-label">{t('bottleDetail.priceEvolution')}</span>
                      {priceHistory.length > 0 ? (
                        <PriceHistoryTimeline history={priceHistory} rates={rates} userCurrency={user?.preferences?.currency || 'USD'} />
                      ) : (
                        <PriceTrackingToggle bottleId={photoBottleId} vintage={vintage} />
                      )}
                    </div>
                  )}
                  {canEditVintage && (
                    <button type="button" className="btn btn-secondary btn-small cvb-edit-vintage" onClick={() => setModal('edit')}>
                      {t('cellarVintageBeta.editVintage', 'Edit vintage')}
                    </button>
                  )}
                </div>
                {data.historyBottleId && !user?.isDemo && (
                  <CollapsibleBlock {...blockProps('vintage.personal', t('personalData.title', 'Your wine data'))}>
                    <PersonalDataCard
                      apiFetch={apiFetch}
                      bottleId={data.historyBottleId}
                      currentUserId={user?.id}
                      wineId={wine?._id}
                      vintage={vintage}
                      scope="vintage"
                      // "This vintage" is scoped through that bottle's own
                      // vintage; an NV group of imported bottles may have none.
                      vintageScopable={!!data.historyBottleVintage}
                    />
                  </CollapsibleBlock>
                )}
                </div>
              </section>

              {/* 3. The bottles: where they sit, what came and went, what was
                  paid — once, at the head of the list (the page label above
                  already says how many) — then one row each with what differs
                  between them. A long list starts folded: the stock line is
                  the glance, the rows are a tap away (beta feedback 2026-10-10). */}
              <section aria-labelledby="cvb-bottles-title">
                <div className="cvb-h2-row">
                  <h2 id="cvb-bottles-title" className="cvb-h2">{t('cellarVintage.bottlesTitle', 'Your bottles')}</h2>
                  <CollapseToggle
                    collapsed={isCollapsed('vintage.bottles')}
                    onToggle={() => toggle('vintage.bottles')}
                    label={t('cellarVintage.bottlesTitle', 'Your bottles')}
                    controls="cvb-bottles-body"
                  />
                </div>
                <div id="cvb-bottles-body" className="cvb-section-body" hidden={isCollapsed('vintage.bottles')}>
                <div className="card cvb-bottles">
                  {stockItems.length > 0 && <div className="cvb-stock">{stockItems}</div>}
                  {bottles.length === 0 ? (
                    <p className="cellar-vintage-empty">{t('cellarVintage.noneLeft', 'None of this vintage left in this cellar.')}</p>
                  ) : (
                    <>
                      {/* One toggle that stays put: focus never falls off a
                          button that vanished under the keyboard. */}
                      {foldable && (
                        <button
                          type="button"
                          className="cvb-bottles-toggle"
                          aria-expanded={!bottlesFolded}
                          aria-controls="cvb-bottle-list"
                          onClick={() => setShowAllBottles(bottlesFolded)}
                        >
                          {bottlesFolded
                            ? t('cellarVintageBeta.showBottles', { count: bottles.length })
                            : t('cellarVintageBeta.hideBottles', 'Fold the list')}
                          <span aria-hidden="true">{bottlesFolded ? ' ▾' : ' ▴'}</span>
                        </button>
                      )}
                      {!bottlesFolded && (
                        <ul id="cvb-bottle-list" className="cvb-bottle-list">
                          {bottles.map((b) => (
                            <BottleRow key={b._id} bottle={b} cellarId={id} fromPath={pagePath} showNote={notes.kind === 'differs'} />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
                {/* What happened to the bottles already drunk, and the other
                    vintages of the wine as links to their own pages. */}
                {data.historyBottleId && (
                  <CollapsibleBlock {...blockProps('vintage.history', t('cellarVintageBeta.historyLabel', 'Drunk and other vintages'))}>
                    <LotHistory
                      apiFetch={apiFetch}
                      bottleId={data.historyBottleId}
                      vintage={vintage}
                      isOwner={cellar?.userRole === 'owner'}
                      vintagePage={{ cellarId: id, fromPath: pagePath, consumedCount: data.consumedCount || 0 }}
                    />
                  </CollapsibleBlock>
                )}
                </div>
              </section>

              {/* Reviews of the wine, this vintage first — as on the bottle page. */}
              {wine && (
                <CollapsibleBlock {...blockProps('vintage.reviews', t('reviews.communityReviews', 'Reviews'))}>
                  <WineReviewsCard wine={wine} vintage={vintage} communityRating={wine.communityRating} />
                </CollapsibleBlock>
              )}
            </div>
          </div>
        </>
      )}

      {/* Phone: the actions in a bar that stays in reach. */}
      {!loading && data && hasActions && (
        <div className="bd-mobile-actions cvb-mobile-actions">
          {canDrink && (
            <button type="button" className="bd-mobile-action-btn bd-mobile-action-consume" onClick={() => setModal('drink')}>
              <span aria-hidden="true">🍷</span> {t('cellarVintageBeta.drinkShort', 'Drink')}
            </button>
          )}
          {canEditVintage && (
            <button type="button" className="bd-mobile-action-btn bd-mobile-action-edit" onClick={() => setModal('edit')}>
              {t('cellarVintageBeta.editVintage', 'Edit vintage')}
            </button>
          )}
          {canAdd && (
            <button type="button" className="bd-mobile-action-btn bd-mobile-action-open" onClick={openAdd}>
              <span aria-hidden="true">➕</span> {t('cellarVintageBeta.addShort', 'Add')}
            </button>
          )}
          {moreMenu('bar')}
        </div>
      )}

      <Suspense fallback={null}>
        {modal === 'drink' && (
          <DrinkOneModal bottles={bottles} wineName={title} onClose={() => setModal(null)} onDone={handleDrunk} />
        )}
        {modal === 'pickList' && (
          <AddToPickListModal choices={pickable} onClose={() => setModal(null)} onDone={() => setModal(null)} />
        )}
        {modal === 'edit' && (
          <EditVintageModal
            bottles={bottles}
            title={title}
            onClose={() => setModal(null)}
            onDone={() => { setModal(null); setNotice(t('cellarVintageBeta.savedNote', 'Saved for the vintage.')); load(); }}
          />
        )}
        {modal === 'add' && addTemplate && (
          <AddMoreBottlesModal
            bottle={addTemplate}
            onClose={() => setModal(null)}
            onAdded={(n) => { setModal(null); setNotice(t('bottleDetail.addMore.success', { count: n })); load(); }}
          />
        )}
        {(modal === 'report' || modal === 'reportWine') && wine && (
          <ReportWineModal
            wine={wine}
            defaultReason={modal === 'report' ? 'wrong_tasting_profile' : null}
            onSuggestFix={canSuggest ? () => { setModal(null); expand('vintage.wine', 'vintage.record'); setSuggestSignal((n) => n + 1); } : undefined}
            onClose={() => setModal(null)}
          />
        )}
        {modal === 'recommend' && wine && (
          <RecommendWineModal wineId={wine._id} wineName={wine.name} onClose={() => setModal(null)} />
        )}
        {modal === 'barcode' && barcodeTargets.length > 0 && (
          <BarcodeScanModal
            bottles={barcodeTargets}
            otherCount={bottles.length - barcodeTargets.length}
            onClose={() => setModal(null)}
            onSaved={(code, { done, total } = { done: 1, total: 1 }) => {
              setModal(null);
              if (done < total) {
                setNotice(code
                  ? t('barcodeScan.savedSome', { count: done, total, code })
                  : t('barcodeScan.removedSome', { count: done, total }));
              } else if (!code) {
                setNotice(t('barcodeScan.removed', 'Barcode removed.'));
              } else {
                // "all" only when it went on every bottle of the vintage.
                setNotice(done < bottles.length
                  ? t('barcodeScan.savedOn', { count: done, code })
                  : t('barcodeScan.savedAll', { count: done, code }));
              }
              load();
            }}
          />
        )}
        {/* A photo of this vintage's label: filed under a bottle of the
            vintage, shown on every bottle of it, reviewed before others see it. */}
        {photoOpen && wine && photoBottleId && (
          <Modal title={t('cellarVintageBeta.addPhoto', 'Add a photo of this vintage')} onClose={closePhoto} showClose trapFocus>
            <p className="cvb-photo-hint">{t('cellarVintageBeta.photoHint', 'A photo of this vintage’s label. It shows on all your bottles of this vintage.')}</p>
            <ImageUpload
              bottleId={photoBottleId}
              wineDefinitionId={wine._id}
              onUploadComplete={refreshPhotos}
              onProcessingComplete={refreshPhotos}
            />
            <p className="cvb-photo-hint">{t('bottleDetail.imageNotice', 'Images are reviewed by an admin before being added to the shared wine registry, where they will be visible to all Cellarion users.')}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={closePhoto}>{t('common.done', 'Done')}</button>
            </div>
          </Modal>
        )}
      </Suspense>
      {journalBottle && (
        <JournalPrompt bottle={journalBottle} onDone={() => { setJournalBottle(null); load(); }} />
      )}
    </div>
  );
}

/**
 * One bottle of the vintage: what differs between them — where it sits, the
 * size when it is not a standard bottle, the price, the shop, when it was
 * bought, open or spoken for, and its own note when the bottles do not share
 * one. The row opens the bottle's own page, which leads back here.
 */
function BottleRow({ bottle, cellarId, fromPath, showNote }) {
  const { t, i18n } = useTranslation();
  const slot = slotLabel(bottle.rackInfo, t);
  const facts = [
    bottle.bottleSize && bottle.bottleSize !== DEFAULT_SIZE ? bottleSizeLabel(bottle.bottleSize, t) : null,
    filled(bottle.price) ? `${bottle.price} ${bottle.currency || ''}`.trim() : null,
    filled(bottle.purchaseLocation) ? bottle.purchaseLocation : null,
    bottle.purchaseDate ? new Date(bottle.purchaseDate).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short' }) : null,
  ].filter(Boolean);
  const open = bottle.openedAt && bottle.status === 'active';
  const reserved = bottle.status === 'active' && isReserved(bottle);
  const note = showNote ? (bottle.notes || '').split('\n')[0].trim() : '';

  return (
    <li>
      <Link to={`/cellars/${cellarId}/bottles/${bottle._id}`} state={{ fromVintage: fromPath }} className="cvb-bottle">
        <span className="cvb-bottle-main">
          <span className="cvb-bottle-slot"><span aria-hidden="true">📍</span> {slot}</span>
          {facts.length > 0 && <span className="cvb-bottle-facts">{facts.join(' · ')}</span>}
          {note && <span className="cvb-bottle-note">{note}</span>}
        </span>
        {(open || reserved) && (
          <span className="cvb-bottle-badges">
            {open && (
              <span className={`open-bottle-badge open-bottle-badge--${freshnessStatus(bottle) || 'ok'}`}>
                🍷 {t('bottleCard.openBadge', '{{glasses}} gl · {{days}}d', { glasses: glassesLeft(bottle), days: Math.max(0, daysLeft(bottle) ?? 0) })}
              </span>
            )}
            {reserved && (
              <span className="reserved-badge" title={reservationSummary(bottle, t)}>
                <span aria-hidden="true">🔖</span> {bottle.reservedUntil != null
                  ? t('bottleCard.reservedUntil', { year: bottle.reservedUntil })
                  : t('bottleCard.reserved')}
              </span>
            )}
          </span>
        )}
        {/* Each bottle still has its own page: its price, slot, opening it. */}
        <span className="cvb-bottle-open">{t('cellarVintageBeta.viewBottle', 'View bottle')} <span aria-hidden="true">›</span></span>
      </Link>
    </li>
  );
}

export default CellarVintageBeta;
