import { useState, useEffect, useRef, Suspense, Fragment } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar, getCellarStatistics, listCellars, getMultiCellarBottles } from '../api/cellars';
import { getRacks } from '../api/racks';
import { getCellarLayout } from '../api/cellarLayout';
import BottleCard from '../components/BottleCard';
import BottleFilterModal from '../components/BottleFilterModal';
import CellarScopePicker from '../components/CellarScopePicker';
import ClimateCard from '../components/ClimateCard';
import CellarNav from '../components/CellarNav';
import CellarPageHeader from '../components/CellarPageHeader';
import './CellarDetail.css';

// The analytics table (#987) loads lazily — it ships its own catalogue fetch,
// query engine client and CSV assembly, none of which the list/card views pay for.
const AnalyticsTable = lazy(() => import('../components/AnalyticsTable'));

// Stable empty rack map for the cross-cellar view (rack placement is per-cellar,
// so it doesn't apply when several cellars are combined).
const EMPTY_RACKMAP = new Map();

// Lazy-load modals — they are heavy and only needed on user interaction
const ShareCellarModal = lazy(() => import('../components/ShareCellarModal'));
const EditCellarModal = lazy(() => import('../components/EditCellarModal').then(m => ({ default: m.EditCellarModal })));
const ColorPickerModal = lazy(() => import('../components/ColorPickerModal').then(m => ({ default: m.ColorPickerModal })));
const DeleteCellarModal = lazy(() => import('../components/DeleteCellarModal').then(m => ({ default: m.DeleteCellarModal })));
const MoveBottleModal = lazy(() => import('../components/MoveBottleModal'));
const BulkPurchaseModal = lazy(() => import('../components/BulkPurchaseModal'));
const BulkConsumeModal = lazy(() => import('../components/BulkConsumeModal'));
const BulkReserveModal = lazy(() => import('../components/BulkReserveModal'));
const BulkAddToListModal = lazy(() => import('../components/BulkAddToListModal'));

// The select-mode bar's actions, in display order. Each opens one modal; all
// of them reuse the single-bottle operations server-side and report skipped
// bottles instead of failing the batch.
const BULK_ACTIONS = [
  { key: 'move',     icon: '📦', label: 'bulk.moveAction' },
  { key: 'purchase', icon: '🧾', label: 'bulk.purchaseAction' },
  { key: 'consume',  icon: '🍷', label: 'bulk.consumeAction' },
  { key: 'reserve',  icon: '🔖', label: 'bulk.reserveAction' },
  { key: 'list',     icon: '📋', label: 'bulk.listAction' },
];

const BOTTLES_PER_PAGE = 30;

// Persist the per-cellar filter/sort selection for the tab session so that
// opening a bottle and hitting browser-back doesn't wipe it (the bottle page is
// a separate route, so CellarDetail unmounts and remounts on the way back).
// Deep-link URL params still take priority; this is only the fallback.
const FILTERS_STORAGE_PREFIX = 'cellarFilters:';
const buildDefaultFilters = () => ({
  search: '', type: [], country: [], region: [], appellation: [],
  grapes: [], vintage: [], minRating: '', maturity: '', unplaced: '', reserved: '', sort: '-createdAt'
});
const readSavedFilters = (cellarId) => {
  try {
    const raw = sessionStorage.getItem(FILTERS_STORAGE_PREFIX + cellarId);
    if (raw) return { ...buildDefaultFilters(), ...JSON.parse(raw) };
  } catch { /* private mode / bad JSON — fall back to defaults */ }
  return null;
};

function CellarDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user } = useAuth();
  const userCurrency = user?.preferences?.currency || 'USD';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cellar, setCellar] = useState(null);
  const [bottles, setBottles] = useState([]);
  const [bottlesTotal, setBottlesTotal] = useState(0);
  const [statistics, setStatistics] = useState(null);
  const [rackMap, setRackMap] = useState(new Map());
  // null = rack layout not yet loaded. Gates the "Unplaced" badge: only badge
  // once we know the cellar has racks (true) — never while loading, and never
  // for cellars with no racks at all (false), where placement isn't a concept.
  const [hasRacks, setHasRacks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bottlesLoading, setBottlesLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // True while the bottle list is in select mode — hides the add-bottle FAB,
  // which otherwise sits on top of the cards being selected.
  const [selecting, setSelecting] = useState(false);
  // Initial tab honours a ?tab=overview deep link (the Overview tab in the
  // shared CellarNav on the other cellar pages links here); after mount the
  // param is cleared like the filter params below, and the in-page toggle takes
  // over as local state.
  const [activeTab, setActiveTab] = useState(() => searchParams.get('tab') === 'overview' ? 'overview' : 'bottles');
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filters, setFilters] = useState(() => {
    // A deep link with any filter param wins (shared/bookmarked URL). Otherwise
    // restore the last-used selection for this cellar so browser-back keeps it.
    const hasUrlFilters = ['search', 'type', 'country', 'region', 'appellation',
      'grapes', 'vintage', 'minRating', 'maturity', 'unplaced', 'reserved', 'sort']
      .some(k => searchParams.has(k));
    if (!hasUrlFilters) return readSavedFilters(id) || buildDefaultFilters();
    return {
      search: searchParams.get('search') || '',
      type: searchParams.get('type')?.split(',').filter(Boolean) || [],
      country: searchParams.get('country')?.split(',').filter(Boolean) || [],
      region: searchParams.get('region')?.split(',').filter(Boolean) || [],
      appellation: searchParams.get('appellation')?.split(',').filter(Boolean) || [],
      grapes: searchParams.get('grapes')?.split(',').filter(Boolean) || [],
      vintage: searchParams.get('vintage')?.split(',').filter(Boolean) || [],
      minRating: searchParams.get('minRating') || '',
      maturity: searchParams.get('maturity') || '',
      unplaced: searchParams.get('unplaced') || '',
      reserved: searchParams.get('reserved') || '',
      sort: searchParams.get('sort') || '-createdAt'
    };
  });
  const [facets, setFacets] = useState(null);
  const [baseFacets, setBaseFacets] = useState(null);
  const [facetMeta, setFacetMeta] = useState(null);
  // Identical bottles (same wine + vintage + size) are always collapsed into one
  // card. Server-side grouped (see ?group=1) so counts are correct across pagination.

  // ── Cross-cellar scope: which cellars this view spans (default: this one) ──
  const [allCellars, setAllCellars] = useState([]);
  const [scopeIds, setScopeIds] = useState([id]);
  const scopeKey = scopeIds.join(',');
  const multiScope = !(scopeIds.length === 1 && scopeIds[0] === id);
  // Shape of the bottles CURRENTLY in state (grouped vs flat). Tracked separately
  // from the live scope selection so a scope change never renders the just-loaded
  // (old-shape) list through the wrong BottlesList branch before the refetch lands.
  const [dataIsMulti, setDataIsMulti] = useState(false);
  // Monotonic fetch token: only the most-recently-started fetch may commit its
  // result. Guards against out-of-order responses when the scope/filter changes
  // (or Load More fires) faster than the network replies — a stale response
  // must never overwrite newer data or append the wrong-shaped page.
  const fetchSeq = useRef(0);

  useEffect(() => {
    listCellars(apiFetch)
      .then(r => r.json())
      .then(d => setAllCellars(d.cellars || []))
      .catch(() => {});
  }, [apiFetch]);

  // Reset scope to just this cellar when navigating to another cellar.
  useEffect(() => { setScopeIds([id]); }, [id]);

  // The unplaced filter is single-cellar only (placement is per-cellar; the
  // cross-cellar endpoint doesn't resolve rack slots) — drop it when the scope
  // widens rather than leaving a chip that silently does nothing.
  useEffect(() => {
    if (multiScope) setFilters(prev => (prev.unplaced ? { ...prev, unplaced: '' } : prev));
  }, [multiScope]);

  // Same single-cellar-only rule for the reserved filter (the cross-cellar
  // endpoint doesn't support ?reserved).
  useEffect(() => {
    if (multiScope) setFilters(prev => (prev.reserved ? { ...prev, reserved: '' } : prev));
  }, [multiScope]);

  // Debounce the search input — only send the API call after the user stops typing
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  const searchTimer = useRef(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(filters.search), 350);
    return () => clearTimeout(searchTimer.current);
  }, [filters.search]);

  // Clear URL search params after they've been read into filter/tab state
  useEffect(() => {
    if (searchParams.has('search') || searchParams.has('vintage') || searchParams.has('minRating') || searchParams.has('sort') || searchParams.has('type') || searchParams.has('country') || searchParams.has('region') || searchParams.has('grapes') || searchParams.has('unplaced') || searchParams.has('reserved') || searchParams.has('tab')) {
      setSearchParams({}, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the filter/sort selection per cellar so it survives leaving the
  // page (e.g. opening a bottle and coming back). Restored by the initializer.
  useEffect(() => {
    try {
      sessionStorage.setItem(FILTERS_STORAGE_PREFIX + id, JSON.stringify(filters));
    } catch { /* quota / private mode — persistence is best-effort */ }
  }, [id, filters]);

  // Serialize array filters for dependency comparison
  const filterKey = [
    debouncedSearch,
    filters.type.join(','), filters.country.join(','), filters.region.join(','),
    filters.appellation.join(','), filters.grapes.join(','), filters.vintage.join(','),
    filters.minRating, filters.maturity, filters.unplaced, filters.reserved, filters.sort
  ].join('|');

  // Refetch on cellar id, filters, or scope change. `id` is included so an
  // in-place navigation to another cellar whose scope key happens to match the
  // current one still refetches; the fetch-seq guard drops the transient
  // stale-scope response that the id→scope-reset produces.
  useEffect(() => {
    fetchCellarData(0);
  }, [id, filterKey, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStatistics();
    fetchRacks();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps


  const fetchCellarData = async (skip) => {
    const seq = ++fetchSeq.current;
    setError(null);
    try {
      if (skip > 0) setBottlesLoading(true);
      const params = new URLSearchParams();
      Object.keys(filters).forEach(key => {
        const val = filters[key];
        if (key === 'search') {
          if (debouncedSearch) params.append('search', debouncedSearch);
        } else if (key === 'unplaced') {
          // Mapped to the backend's excludePlaced param below — single-cellar
          // only (the cross-cellar endpoint doesn't resolve rack slots).
        } else if (key === 'reserved') {
          // Set below — single-cellar only (the cross-cellar endpoint doesn't
          // support ?reserved).
        } else if (Array.isArray(val)) {
          if (val.length > 0) params.append(key, val.join(','));
        } else if (val) {
          params.append(key, val);
        }
      });
      params.set('limit', BOTTLES_PER_PAGE);
      params.set('skip', skip);
      const multi = !(scopeIds.length === 1 && scopeIds[0] === id);
      let res;
      if (multi) {
        params.set('cellars', scopeIds.join(','));
        res = await getMultiCellarBottles(apiFetch, params.toString());
      } else {
        params.set('group', '1');
        if (filters.unplaced) params.set('excludePlaced', '1');
        if (filters.reserved) params.set('reserved', '1');
        res = await getCellar(apiFetch, id, params);
      }
      const data = await res.json();
      // A newer fetch started while this one was in flight — drop this response
      // so it can't overwrite newer data or append a wrong-shaped page.
      if (seq !== fetchSeq.current) return;
      if (res.ok) {
        if (data.cellar) setCellar(data.cellar);
        setBottlesTotal(data.bottles.total);
        if (skip === 0) {
          // Set the data + its shape together so BottlesList never sees a
          // shape/flag mismatch (grouped items rendered as flat, or vice-versa).
          setBottles(data.bottles.items);
          setDataIsMulti(multi);
          // Update facets on every fetch so cascading filters work
          if (data.facets) setFacets(data.facets);
          if (data.baseFacets) setBaseFacets(data.baseFacets);
          if (data.facetMeta) setFacetMeta(data.facetMeta);
        } else {
          setBottles(prev => [...prev, ...data.bottles.items]);
        }
      } else {
        setError(data.error || 'Failed to load cellar');
      }
    } catch {
      if (seq === fetchSeq.current) setError('Network error');
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setBottlesLoading(false);
      }
    }
  };

  const loadMore = () => fetchCellarData(bottles.length);

  const fetchStatistics = async () => {
    try {
      const res = await getCellarStatistics(apiFetch, id, userCurrency);
      const data = await res.json();
      if (res.ok) setStatistics(data.statistics);
    } catch {}
  };

  const fetchRacks = async () => {
    setHasRacks(null);
    try {
      const [racksRes, layoutRes] = await Promise.all([
        getRacks(apiFetch, id),
        getCellarLayout(apiFetch, id),
      ]);
      const racksData = await racksRes.json();
      const layoutData = await layoutRes.json();
      if (racksRes.ok) {
        const placements = layoutData.layout?.rackPlacements || [];
        const placedRackIds = new Set(placements.map(rp => (rp.rack?._id || rp.rack).toString()));
        const map = new Map();
        racksData.racks.forEach(rack => {
          const inRoom = placedRackIds.has(rack._id.toString());
          rack.slots.forEach(slot => {
            const bid = slot.bottle?._id || slot.bottle;
            if (bid) map.set(bid.toString(), { rackId: rack._id, rackName: rack.name, position: slot.position, inRoom });
          });
        });
        setRackMap(map);
        setHasRacks((racksData.racks || []).length > 0);
      }
    } catch {}
  };

  const canEdit = cellar?.userRole === 'owner' || cellar?.userRole === 'editor';

  // Only replace the whole page when we have nothing to show yet; once the
  // cellar is loaded, transient fetch failures render as an inline banner.
  if (error && !cellar) return <div className="alert alert-error">{error}</div>;

  return (
    <div className="cellar-detail-page">
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
      {/* ── Header — shared shape so the nav anchors at the same Y everywhere ── */}
      <CellarPageHeader
        backTo="/cellars?all=1"
        backLabel={t('cellarDetail.backToCellars')}
        title={cellar?.name}
        loading={loading}
        userColor={cellar?.userColor}
        subtitle={cellar?.description}
        titleBadge={!loading && cellar?.userRole && cellar.userRole !== 'owner' ? (
          <span className={`shared-role-tag shared-role-tag--${cellar.userRole}`} style={{ marginLeft: '0.5rem' }}>
            {t('cellarDetail.sharedBy')} {cellar.user?.username}
          </span>
        ) : null}
        actions={!loading && (
          <>
            {canEdit && !user?.isDemo && (
              <Link to={`/cellars/${id}/add-bottle`} className="btn btn-primary btn-small cph-desktop-only">
                + {t('cellarDetail.addBottle')}
              </Link>
            )}
            <div className="more-menu-wrap">
              <button
                className="btn btn-secondary btn-small btn-more"
                onClick={() => setMoreOpen(o => !o)}
                aria-label={t('cellarDetail.moreActions')}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
              </button>
              {moreOpen && (
                <>
                  <div className="more-menu-backdrop" onClick={() => setMoreOpen(false)} aria-hidden="true" />
                  {/* Views (Racks/History/…) live in the CellarNav strip —
                      this menu holds actions only: Manage / Data / Danger. */}
                  <div className="more-menu-dropdown" role="menu">
                    {cellar.userRole === 'owner' && (
                      <button
                        className="more-menu-item"
                        onClick={() => { setShowEditModal(true); setMoreOpen(false); }}
                      >
                        <span aria-hidden="true">✏️</span> {t('cellarDetail.editCellar')}
                      </button>
                    )}
                    <button
                      className="more-menu-item"
                      onClick={() => setShowColorPicker(true) || setMoreOpen(false)}
                    >
                      <span aria-hidden="true">🎨</span> {t('cellarDetail.setColor')}
                    </button>
                    {cellar.userRole === 'owner' && (
                      <button
                        className="more-menu-item"
                        onClick={() => { setShowShareModal(true); setMoreOpen(false); }}
                      >
                        <span aria-hidden="true">🔗</span> {t('cellarDetail.share')}
                      </button>
                    )}
                    {cellar.userRole === 'owner' && (
                      <Link
                        to={`/cellars/${id}/wine-lists`}
                        className="more-menu-item"
                        onClick={() => setMoreOpen(false)}
                      >
                        <span aria-hidden="true">📋</span> {t('cellarDetail.wineLists')}
                      </Link>
                    )}
                    {(canEdit || cellar.userRole === 'owner') && <div className="more-menu-divider" />}
                    {canEdit && (
                      <Link
                        to={`/cellars/${id}/import`}
                        className="more-menu-item"
                        onClick={() => setMoreOpen(false)}
                      >
                        <span aria-hidden="true">📥</span> {t('cellarDetail.importBottles')}
                      </Link>
                    )}
                    {cellar.userRole === 'owner' && (
                      <Link
                        to={`/export-cellar?cellar=${id}`}
                        className="more-menu-item"
                        onClick={() => setMoreOpen(false)}
                      >
                        <span aria-hidden="true">📤</span> {t('cellarDetail.export')}
                      </Link>
                    )}
                    {cellar.userRole === 'owner' && (
                      <Link
                        to={`/cellars/${id}/audit`}
                        className="more-menu-item"
                        onClick={() => setMoreOpen(false)}
                      >
                        <span aria-hidden="true">🧾</span> {t('cellarDetail.auditLog')}
                      </Link>
                    )}
                    {cellar.userRole === 'owner' && (
                      <>
                        <div className="more-menu-divider" />
                        <button
                          className="more-menu-item more-menu-item--danger"
                          onClick={() => { setShowDeleteModal(true); setMoreOpen(false); }}
                        >
                          <span aria-hidden="true">🗑️</span> {t('cellarDetail.deleteCellar')}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      />

      {/* ── View switcher: in-page Bottles/Overview toggles + links to every
             other cellar view (shared CellarNav strip used on all subpages) ── */}
      <CellarNav cellarId={id}>
        <button
          className={`cellar-nav-tab ${activeTab === 'bottles' ? 'active' : ''}`}
          onClick={() => setActiveTab('bottles')}
        >
          {t('cellarDetail.tabBottles')}
          {statistics && <span className="tab-count">{statistics.totalBottles}</span>}
        </button>
        <button
          className={`cellar-nav-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          {t('cellarDetail.tabOverview')}
        </button>
      </CellarNav>

      {/* ── Overview tab ── */}
      {activeTab === 'overview' && !loading && (
        <div className="cellar-tab-content">
          {statistics && (
            <div className="statistics-grid">
              <div className="stat-card">
                <h2>{statistics.totalBottles}</h2>
                <p>{t('cellarDetail.totalBottles')}</p>
              </div>
              <div className="stat-card">
                <h2>{statistics.uniqueWines}</h2>
                <p>{t('cellarDetail.uniqueWines')}</p>
              </div>
              <div className="stat-card">
                <h2>{statistics.convertedTotal.toFixed(2)} {userCurrency}</h2>
                <p>{t('cellarDetail.totalValue')}</p>
              </div>
              <div className="stat-card">
                <h2>{statistics.convertedAverage.toFixed(2)} {userCurrency}</h2>
                <p>{t('cellarDetail.avgPrice')}</p>
              </div>
            </div>
          )}

          {/* Climate card — self-hides when the cellar has no sensor devices */}
          <ClimateCard cellarId={id} />

          {/* Quick links */}
          <div className="overview-links">
            <Link to={`/cellars/${id}/racks`} className="overview-link-card">
              <span className="overview-link-icon" aria-hidden="true">🗄️</span>
              <div>
                <strong>{t('cellarDetail.racks')}</strong>
                <span>{t('cellarDetail.viewRackLayout')}</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
            <Link to={`/cellars/${id}/room`} className="overview-link-card">
              <span className="overview-link-icon" aria-hidden="true">🏠</span>
              <div>
                <strong>{t('cellarDetail.roomView', 'Room View')}</strong>
                <span>{t('cellarDetail.roomViewDesc', '3D cellar layout')}</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
            {cellar.userRole === 'owner' && (
              <Link to={`/cellars/${id}/wine-lists`} className="overview-link-card">
                <span className="overview-link-icon" aria-hidden="true">📋</span>
                <div>
                  <strong>{t('cellarDetail.wineLists')}</strong>
                  <span>{t('cellarDetail.wineListsDesc')}</span>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
              </Link>
            )}
            <Link to={`/cellars/${id}/history`} className="overview-link-card">
              <span className="overview-link-icon" aria-hidden="true">📖</span>
              <div>
                <strong>{t('cellarDetail.history')}</strong>
                <span>{t('cellarDetail.consumedBottles')}</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
            <Link to={`/cellars/${id}/book`} className="overview-link-card">
              <span className="overview-link-icon" aria-hidden="true">📕</span>
              <div>
                <strong>{t('cellarBook.linkBtn', 'Cellar Book')}</strong>
                <span>{t('cellarBook.linkDesc', 'Printable rack maps & lists')}</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
          </div>
        </div>
      )}

      {/* ── Bottles tab — search bar renders immediately for fast LCP ── */}
      {activeTab === 'bottles' && (
        <div className="cellar-tab-content">
          {(() => {
            // Build list of active filter chips for the active-filters bar
            const activeChips = [];
            const reverseMap = (map) => {
              const rev = {};
              if (map) Object.entries(map).forEach(([name, id]) => { rev[id] = name; });
              return rev;
            };
            const countryNames = reverseMap(facetMeta?.countries);
            const regionNames = reverseMap(facetMeta?.regions);
            const grapeNames = reverseMap(facetMeta?.grapes);

            (filters.type || []).forEach(v => activeChips.push({ key: 'type', value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
            (filters.country || []).forEach(v => activeChips.push({ key: 'country', value: v, label: countryNames[v] || v }));
            (filters.region || []).forEach(v => activeChips.push({ key: 'region', value: v, label: regionNames[v] || v }));
            (filters.appellation || []).forEach(v => activeChips.push({ key: 'appellation', value: v, label: v }));
            (filters.grapes || []).forEach(v => activeChips.push({ key: 'grapes', value: v, label: grapeNames[v] || v }));
            (filters.vintage || []).forEach(v => activeChips.push({ key: 'vintage', value: v, label: v }));
            if (filters.minRating) activeChips.push({ key: 'minRating', value: filters.minRating, label: `${filters.minRating}+ rating` });
            if (filters.maturity) activeChips.push({ key: 'maturity', value: filters.maturity, label: filters.maturity });
            if (filters.unplaced) activeChips.push({ key: 'unplaced', value: '1', label: t('cellarDetail.unplacedOnly', 'Unplaced only') });
            if (filters.reserved) activeChips.push({ key: 'reserved', value: '1', label: t('cellarDetail.reservedOnly', 'Reserved only') });

            const removeChip = (chip) => {
              setFilters(prev => {
                const val = prev[chip.key];
                if (Array.isArray(val)) {
                  return { ...prev, [chip.key]: val.filter(v => v !== chip.value) };
                }
                return { ...prev, [chip.key]: '' };
              });
            };

            const clearAll = () => setFilters(prev => ({
              ...prev,
              type: [], country: [], region: [], appellation: [], grapes: [], vintage: [],
              minRating: '', maturity: '', unplaced: '', reserved: ''
            }));

            return (
              <>
                <div className="search-row">
                  <input
                    type="text"
                    placeholder={t('cellarDetail.searchPlaceholder')}
                    value={filters.search}
                    onChange={e => setFilters({ ...filters, search: e.target.value })}
                    className="search-input"
                    aria-label={t('cellarDetail.searchPlaceholder')}
                  />
                  <button
                    type="button"
                    className={`filter-toggle-btn${activeChips.length > 0 ? ' filter-toggle-btn--has-filters' : ''}`}
                    onClick={() => setShowFilterModal(true)}
                    aria-label={t('cellarDetail.toggleFilters')}
                    title={t('cellarDetail.toggleFilters')}
                  >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path d="M2 4h16M5 10h10M8 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    {activeChips.length > 0 && (
                      <span className="filter-badge">{activeChips.length}</span>
                    )}
                  </button>
                  <select
                    value={filters.sort}
                    onChange={e => setFilters({ ...filters, sort: e.target.value })}
                    className="filter-select sort-select"
                    aria-label={t('cellarDetail.sortBottlesAria')}
                  >
                    <option value="-createdAt">{t('cellarDetail.sortNewest')}</option>
                    <option value="createdAt">{t('cellarDetail.sortOldest')}</option>
                    <option value="name">{t('cellarDetail.sortNameAZ')}</option>
                    <option value="-name">{t('cellarDetail.sortNameZA')}</option>
                    <option value="vintage">{t('cellarDetail.sortVintageOld')}</option>
                    <option value="-vintage">{t('cellarDetail.sortVintageNew')}</option>
                    <option value="price">{t('cellarDetail.sortPriceLow')}</option>
                    <option value="-price">{t('cellarDetail.sortPriceHigh')}</option>
                    <option value="maturity">{t('cellarDetail.sortMaturity')}</option>
                  </select>
                  {allCellars.length > 1 && (
                    <CellarScopePicker
                      cellars={allCellars}
                      value={scopeIds}
                      currentCellarId={id}
                      onChange={setScopeIds}
                    />
                  )}
                </div>

                {activeChips.length > 0 && (
                  <div className="active-filters-row">
                    {activeChips.map((chip, i) => (
                      <span key={`${chip.key}-${chip.value}-${i}`} className="active-filter-chip">
                        {chip.label}
                        <button
                          type="button"
                          className="active-filter-chip-remove"
                          onClick={() => removeChip(chip)}
                          aria-label={t('cellarDetail.removeFilterAria', { label: chip.label })}
                        >×</button>
                      </span>
                    ))}
                    <button type="button" className="active-filters-clear" onClick={clearAll}>
                      {t('cellarDetail.clearAllFilters')}
                    </button>
                  </div>
                )}

                {showFilterModal && (
                  <Suspense fallback={null}>
                    <BottleFilterModal
                      filters={filters}
                      onApply={setFilters}
                      onClose={() => setShowFilterModal(false)}
                      facets={facets}
                      baseFacets={baseFacets}
                      facetMeta={facetMeta}
                      bottlesTotal={bottlesTotal}
                      showUnplaced={!multiScope && hasRacks === true}
                      showReserved={!multiScope}
                    />
                  </Suspense>
                )}
              </>
            );
          })()}

          {loading ? (
            <div className="loading">{t('cellarDetail.loadingCellar')}</div>
          ) : bottles.length === 0 && !bottlesLoading ? (
            (filters.search || filters.vintage?.length || filters.minRating || filters.maturity || filters.unplaced || filters.reserved || filters.type?.length || filters.country?.length || filters.region?.length || filters.appellation?.length || filters.grapes?.length) ? (
              <div className="empty-state">
                <p>{t('cellarDetail.noSearchResults')}</p>
              </div>
            ) : (
              <div className="empty-state">
                <p>{t('cellarDetail.noBottles')}</p>
                {canEdit && (
                  <Link to={`/cellars/${id}/add-bottle`} className="btn btn-primary">
                    {t('cellarDetail.addFirstBottle')}
                  </Link>
                )}
              </div>
            )
          ) : (
            <BottlesList
              bottles={bottles}
              rackMap={dataIsMulti ? EMPTY_RACKMAP : rackMap}
              cellarId={id}
              hasMore={bottles.length < bottlesTotal}
              loadingMore={bottlesLoading}
              onLoadMore={loadMore}
              multi={dataIsMulti}
              rackKnown={!dataIsMulti && hasRacks === true}
              canBulkMove={!dataIsMulti && cellar?.userRole === 'owner'}
              onBulkDone={() => { fetchCellarData(0); fetchStatistics(); fetchRacks(); }}
              onSelectModeChange={setSelecting}
            />
          )}
        </div>
      )}

      {/* ── FAB: Add Bottle (mobile only) — hidden while selecting bottles ── */}
      {!loading && canEdit && !selecting && (
        <Link
          to={`/cellars/${id}/add-bottle`}
          className="fab"
          aria-label={t('cellarDetail.addBottle')}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </Link>
      )}

      <Suspense fallback={null}>
        {showShareModal && (
          <ShareCellarModal
            cellarId={id}
            cellarName={cellar.name}
            onClose={() => setShowShareModal(false)}
          />
        )}

        {showEditModal && (
          <EditCellarModal
            cellar={cellar}
            onSaved={updated => { setCellar(updated); setShowEditModal(false); }}
            onClose={() => setShowEditModal(false)}
          />
        )}

        {showColorPicker && (
          <ColorPickerModal
            currentColor={cellar.userColor}
            cellarId={id}
            onSaved={userColor => { setCellar(c => ({ ...c, userColor })); setShowColorPicker(false); }}
            onClose={() => setShowColorPicker(false)}
          />
        )}

        {showDeleteModal && (
          <DeleteCellarModal
            cellar={cellar}
            onDeleted={() => navigate('/cellars')}
            onClose={() => setShowDeleteModal(false)}
          />
        )}
      </Suspense>
    </div>
  );
}

// ── Bottle list (list or card view) ──
// `multi` = cross-cellar view: `bottles` is a flat list (no grouping), each item
// carries its own `cellar` id + `cellarName` so it links to and is badged with
// the right cellar.
// `canBulkMove` (owner of this one cellar) enables select mode and its bulk
// actions; `onBulkDone` refreshes the parent's list, stats and racks after
// one; `onSelectModeChange` tells the parent to hide the FAB meanwhile.
function BottlesList({ bottles, rackMap, cellarId, hasMore, loadingMore, onLoadMore, multi = false, rackKnown = false, canBulkMove = false, onBulkDone, onSelectModeChange }) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('cellarion_bottle_view') || 'list'; } catch { return 'list'; }
  });
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem('cellarion_bottle_density') || 'comfortable'; } catch { return 'comfortable'; }
  });
  const [showNotes, setShowNotes] = useState(() => {
    try { return localStorage.getItem('cellarion_bottle_notes') === '1'; } catch { return false; }
  });
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  // ── Multi-select → "Move to cellar" (support ticket 6a9949e3, 2026-09-03:
  // a whole delivery logged in a storage cellar had to go home one bottle at
  // a time). Owner-only and single-cellar — the parent gates canBulkMove. A
  // collapsed group toggles all of its bottles at once, which is exactly the
  // delivery case; expand the group to pick individual bottles.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkAction, setBulkAction] = useState(null); // a BULK_ACTIONS key, or null
  const idsOf = (item) => (Array.isArray(item?.bottles) ? item.bottles.map(b => b._id) : [item._id]);
  // Long-press on a card: enter select mode with that card already ticked.
  const enterSelectWith = (ids) => {
    if (!canBulkMove) return;
    setSelectMode(true);
    setSelectedIds(prev => { const next = new Set(prev); ids.forEach(x => next.add(x)); return next; });
  };
  const closeAction = () => setBulkAction(null);
  const finishAction = () => { setBulkAction(null); setSelectMode(false); setSelectedIds(new Set()); onBulkDone?.(); };
  const allLoadedIds = bottles.flatMap(idsOf);
  const isSelected = (ids) => ids.length > 0 && ids.every(x => selectedIds.has(x));
  const toggleIds = (ids) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const allOn = ids.every(x => next.has(x));
      ids.forEach(x => (allOn ? next.delete(x) : next.add(x)));
      return next;
    });
  };
  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()); };
  // Leaving the owner/single-cellar case (scope widened, cellar changed) ends
  // select mode rather than leaving checked cards nothing can act on.
  useEffect(() => {
    if (!canBulkMove) { setSelectMode(false); setSelectedIds(new Set()); }
  }, [canBulkMove, cellarId]);
  const selectableNow = selectMode && canBulkMove && viewMode !== 'table';
  useEffect(() => { onSelectModeChange?.(selectableNow); }, [selectableNow, onSelectModeChange]);

  const setView = (mode) => {
    setViewMode(mode);
    try { localStorage.setItem('cellarion_bottle_view', mode); } catch {}
  };

  const setDens = (mode) => {
    setDensity(mode);
    try { localStorage.setItem('cellarion_bottle_density', mode); } catch {}
  };

  const toggleNotes = () => {
    setShowNotes(on => {
      try { localStorage.setItem('cellarion_bottle_notes', on ? '0' : '1'); } catch {}
      return !on;
    });
  };

  // Compact only applies to list view — the grid's height is driven by the image.
  const compact = viewMode === 'list' && density === 'compact';
  // Notes preview likewise: the grid tiles have no room for a text line.
  const notesOn = viewMode === 'list' && showNotes;

  const toggleGroup = (key) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div className="bottles-view-toggle">
        {canBulkMove && viewMode !== 'table' && (
          <button
            type="button"
            className={`view-toggle-btn select-toggle-btn ${selectMode ? 'active' : ''}`}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            aria-pressed={selectMode}
            title={t('cellarDetail.selectBottlesTitle')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="7 12 11 16 17 8"/></svg>
            {t('cellarDetail.selectBottles')}
          </button>
        )}
        {viewMode === 'list' && (
          <button
            className={`view-toggle-btn notes-toggle-btn ${showNotes ? 'active' : ''}`}
            onClick={toggleNotes}
            aria-label={t('cellarDetail.showNotes', 'Show notes')}
            aria-pressed={showNotes}
            title={t('cellarDetail.showNotes', 'Show notes')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
        )}
        {viewMode === 'list' && (
          <button
            className={`view-toggle-btn density-toggle-btn ${density === 'compact' ? 'active' : ''}`}
            onClick={() => setDens(density === 'compact' ? 'comfortable' : 'compact')}
            aria-label={t('cellarDetail.compactView', 'Compact view')}
            aria-pressed={density === 'compact'}
            title={t('cellarDetail.compactView', 'Compact view')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
        )}
        <button
          className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
          onClick={() => setView('list')}
          aria-label="List view"
          aria-pressed={viewMode === 'list'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        </button>
        <button
          className={`view-toggle-btn ${viewMode === 'card' ? 'active' : ''}`}
          onClick={() => setView('card')}
          aria-label="Card view"
          aria-pressed={viewMode === 'card'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        </button>
        <button
          className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
          onClick={() => setView('table')}
          aria-label={t('analytics.tableView', 'Table view')}
          aria-pressed={viewMode === 'table'}
          title={t('analytics.tableView', 'Table view')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        </button>
      </div>

      {selectableNow && (
        <div className="bulk-bar" role="region" aria-label={t('cellarDetail.bulkBarAria')}>
          <div className="bulk-bar-head">
            <span className="bulk-bar-count" aria-live="polite">
              {t('cellarDetail.selectedCount', { count: selectedIds.size })}
            </span>
            <button
              type="button"
              className="bulk-bar-link"
              onClick={() => setSelectedIds(new Set(allLoadedIds))}
              disabled={allLoadedIds.length === 0 || isSelected(allLoadedIds)}
            >
              {t('cellarDetail.selectAllLoaded', { count: allLoadedIds.length })}
            </button>
            <button type="button" className="bulk-bar-close" onClick={exitSelect} aria-label={t('common.cancel')} title={t('common.cancel')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="bulk-bar-actions">
            {BULK_ACTIONS.map(a => (
              <button
                key={a.key}
                type="button"
                className="bulk-action-btn"
                onClick={() => setBulkAction(a.key)}
                disabled={selectedIds.size === 0}
              >
                <span className="bulk-action-icon" aria-hidden="true">{a.icon}</span>
                <span className="bulk-action-label">{t(a.label)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {viewMode === 'table' ? (
        <Suspense fallback={<div className="load-more-wrap">{t('common.loading')}</div>}>
          <AnalyticsTable cellarId={multi ? null : cellarId} />
        </Suspense>
      ) : (
      <>
      <div className={viewMode === 'list' ? 'bottles-list' : 'bottles-grid'}>
        {bottles.map(item => {
          // Cross-cellar view: flat bottles, each linked to + badged with its cellar.
          if (multi) {
            return (
              <BottleCard
                key={item._id}
                bottle={item}
                rackMap={rackMap}
                cellarId={item.cellar || cellarId}
                viewMode={viewMode}
                showCellarBadge
                compact={compact}
                rackKnown={rackKnown}
                showNotes={notesOn}
              />
            );
          }
          // Grouped response: item = { key, count, bottles: [...] }
          if (item && Array.isArray(item.bottles)) {
            const rep = item.bottles[0];
            if (item.count === 1) {
              return (
                <BottleCard key={rep._id} bottle={rep} rackMap={rackMap} cellarId={cellarId} viewMode={viewMode} compact={compact} rackKnown={rackKnown} showNotes={notesOn} selectable={selectableNow} selected={isSelected(idsOf(item))} onToggleSelect={() => toggleIds(idsOf(item))} onLongPress={canBulkMove ? () => enterSelectWith(idsOf(item)) : undefined} />
              );
            }
            if (!expandedGroups.has(item.key)) {
              return (
                <BottleCard
                  key={item.key}
                  bottle={rep}
                  rackMap={rackMap}
                  cellarId={cellarId}
                  viewMode={viewMode}
                  groupCount={item.count}
                  onClick={() => toggleGroup(item.key)}
                  selectable={selectableNow}
                  selected={isSelected(idsOf(item))}
                  onToggleSelect={() => toggleIds(idsOf(item))}
                  onLongPress={canBulkMove ? () => enterSelectWith(idsOf(item)) : undefined}
                  compact={compact}
                  rackKnown={rackKnown}
                  showNotes={notesOn}
                />
              );
            }
            const wineName = rep.wineDefinition?.name || rep.pendingWineRequest?.wineName || t('common.unknownWine');
            return (
              <Fragment key={item.key}>
                <div className="bottle-group-bar">
                  <span><strong>{wineName}</strong> · {rep.vintage || 'NV'} · {t('cellarDetail.groupBottleCount', { count: item.count })}</span>
                  <button type="button" className="bottle-group-collapse" onClick={() => toggleGroup(item.key)}>
                    {t('cellarDetail.collapseGroup')}
                  </button>
                </div>
                {item.bottles.map(b => (
                  <BottleCard key={b._id} bottle={b} rackMap={rackMap} cellarId={cellarId} viewMode={viewMode} compact={compact} rackKnown={rackKnown} showNotes={notesOn} selectable={selectableNow} selected={isSelected([b._id])} onToggleSelect={() => toggleIds([b._id])} onLongPress={canBulkMove ? () => enterSelectWith([b._id]) : undefined} />
                ))}
              </Fragment>
            );
          }
          // Defensive fallback: a plain bottle item (responses are always grouped)
          return (
            <BottleCard key={item._id} bottle={item} rackMap={rackMap} cellarId={cellarId} viewMode={viewMode} compact={compact} rackKnown={rackKnown} showNotes={notesOn} selectable={selectableNow} selected={isSelected([item._id])} onToggleSelect={() => toggleIds([item._id])} onLongPress={canBulkMove ? () => enterSelectWith([item._id]) : undefined} />
          );
        })}
      </div>

      {hasMore && (
        <div className="load-more-wrap">
          <button
            className="btn btn-secondary"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? t('common.loading') : t('cellarDetail.loadMore')}
          </button>
        </div>
      )}
      </>
      )}

      <Suspense fallback={null}>
        {bulkAction === 'move' && (
          <MoveBottleModal bottleIds={[...selectedIds]} currentCellarId={cellarId} onClose={closeAction} onMoved={finishAction} />
        )}
        {bulkAction === 'purchase' && (
          <BulkPurchaseModal bottleIds={[...selectedIds]} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'consume' && (
          <BulkConsumeModal bottleIds={[...selectedIds]} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'reserve' && (
          <BulkReserveModal bottleIds={[...selectedIds]} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'list' && (
          <BulkAddToListModal bottleIds={[...selectedIds]} cellarId={cellarId} onClose={closeAction} onDone={finishAction} />
        )}
      </Suspense>
    </>
  );
}

export default CellarDetail;
