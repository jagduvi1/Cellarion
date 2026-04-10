import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar, getCellarStatistics, exportCellar } from '../api/cellars';
import { getRacks } from '../api/racks';
import { getCellarLayout } from '../api/cellarLayout';
import BottleCard from '../components/BottleCard';
import BottleFilterModal from '../components/BottleFilterModal';
import downloadBlob from '../utils/downloadBlob';
import './CellarDetail.css';

// Lazy-load modals — they are heavy and only needed on user interaction
const ShareCellarModal = lazy(() => import('../components/ShareCellarModal'));
const EditCellarModal = lazy(() => import('../components/EditCellarModal').then(m => ({ default: m.EditCellarModal })));
const ColorPickerModal = lazy(() => import('../components/ColorPickerModal').then(m => ({ default: m.ColorPickerModal })));
const DeleteCellarModal = lazy(() => import('../components/DeleteCellarModal').then(m => ({ default: m.DeleteCellarModal })));

const BOTTLES_PER_PAGE = 30;

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
  const [loading, setLoading] = useState(true);
  const [bottlesLoading, setBottlesLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('bottles');
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filters, setFilters] = useState(() => ({
    search: searchParams.get('search') || '',
    type: searchParams.get('type')?.split(',').filter(Boolean) || [],
    country: searchParams.get('country')?.split(',').filter(Boolean) || [],
    region: searchParams.get('region')?.split(',').filter(Boolean) || [],
    grapes: searchParams.get('grapes')?.split(',').filter(Boolean) || [],
    vintage: searchParams.get('vintage')?.split(',').filter(Boolean) || [],
    minRating: searchParams.get('minRating') || '',
    maturity: searchParams.get('maturity') || '',
    sort: searchParams.get('sort') || '-createdAt'
  }));
  const [facets, setFacets] = useState(null);
  const [baseFacets, setBaseFacets] = useState(null);
  const [facetMeta, setFacetMeta] = useState(null);

  // Debounce the search input — only send the API call after the user stops typing
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  const searchTimer = useRef(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(filters.search), 350);
    return () => clearTimeout(searchTimer.current);
  }, [filters.search]);

  // Clear URL search params after they've been read into filter state
  useEffect(() => {
    if (searchParams.has('search') || searchParams.has('vintage') || searchParams.has('minRating') || searchParams.has('sort') || searchParams.has('type') || searchParams.has('country') || searchParams.has('region') || searchParams.has('grapes')) {
      setSearchParams({}, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Serialize array filters for dependency comparison
  const filterKey = [
    debouncedSearch,
    filters.type.join(','), filters.country.join(','), filters.region.join(','),
    filters.grapes.join(','), filters.vintage.join(','),
    filters.minRating, filters.maturity, filters.sort
  ].join('|');

  useEffect(() => {
    fetchCellarData(0);
  }, [id, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStatistics();
    fetchRacks();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps


  const fetchCellarData = async (skip) => {
    try {
      if (skip > 0) setBottlesLoading(true);
      const params = new URLSearchParams();
      Object.keys(filters).forEach(key => {
        const val = filters[key];
        if (key === 'search') {
          if (debouncedSearch) params.append('search', debouncedSearch);
        } else if (Array.isArray(val)) {
          if (val.length > 0) params.append(key, val.join(','));
        } else if (val) {
          params.append(key, val);
        }
      });
      params.set('limit', BOTTLES_PER_PAGE);
      params.set('skip', skip);
      const res = await getCellar(apiFetch, id, params);
      const data = await res.json();
      if (res.ok) {
        setCellar(data.cellar);
        setBottlesTotal(data.bottles.total);
        if (skip === 0) {
          setBottles(data.bottles.items);
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
      setError('Network error');
    } finally {
      setLoading(false);
      setBottlesLoading(false);
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
      }
    } catch {}
  };

  const canEdit = cellar?.userRole === 'owner' || cellar?.userRole === 'editor';

  if (error) return <div className="alert alert-error">{error}</div>;

  const h1Style = cellar?.userColor
    ? { '--cellar-color': cellar.userColor }
    : {};
  const h1Class = cellar?.userColor ? 'cellar-accent-border' : '';

  return (
    <div className="cellar-detail-page">
      {/* ── Header — shell renders immediately, details fill in after load ── */}
      <div className="cellar-header">
        <div className="cellar-header-top">
          <Link to="/cellars?all=1" className="back-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
            {t('cellarDetail.backToCellars')}
          </Link>
          {/* Desktop-only add bottle button */}
          {!loading && (
            <div className="cellar-header-desktop-actions">
              {canEdit && (
                <Link to={`/cellars/${id}/add-bottle`} className="btn btn-primary btn-small" data-guide="add-bottle">
                  + {t('cellarDetail.addBottle')}
                </Link>
              )}
              <div className="more-menu-wrap">
                <button
                  className="btn btn-secondary btn-small btn-more"
                  data-guide="more-menu-btn"
                  onClick={() => setMoreOpen(o => !o)}
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                </button>
                {moreOpen && (
                  <>
                    <div className="more-menu-backdrop" onClick={() => setMoreOpen(false)} aria-hidden="true" />
                    <div className="more-menu-dropdown" role="menu">
                      <button
                        className="more-menu-item"
                        onClick={() => setShowColorPicker(true) || setMoreOpen(false)}
                      >
                        <span aria-hidden="true">🎨</span> {t('cellarDetail.setColor')}
                      </button>
                      {cellar.userRole === 'owner' && (
                        <button
                          className="more-menu-item"
                          onClick={() => { setShowEditModal(true); setMoreOpen(false); }}
                        >
                          <span aria-hidden="true">✏️</span> {t('cellarDetail.editCellar')}
                        </button>
                      )}
                      {cellar.userRole === 'owner' && (
                        <button
                          className="more-menu-item"
                          data-guide="share-cellar"
                          onClick={() => { setShowShareModal(true); setMoreOpen(false); }}
                        >
                          <span aria-hidden="true">🔗</span> {t('cellarDetail.share')}
                        </button>
                      )}
                      <Link
                        to={`/cellars/${id}/racks`}
                        className="more-menu-item"
                        data-guide="rack-view"
                        onClick={() => setMoreOpen(false)}
                      >
                        <span aria-hidden="true">🗄️</span> {t('cellarDetail.racks')}
                      </Link>
                      {cellar.userRole === 'owner' && (
                        <Link
                          to={`/cellars/${id}/wine-lists`}
                          className="more-menu-item"
                          onClick={() => setMoreOpen(false)}
                        >
                          <span aria-hidden="true">📋</span> Wine Lists
                        </Link>
                      )}
                      <Link
                        to={`/cellars/${id}/history`}
                        className="more-menu-item"
                        data-guide="cellar-history"
                        onClick={() => setMoreOpen(false)}
                      >
                        <span aria-hidden="true">📖</span> {t('cellarDetail.historyMenuItem')}
                      </Link>
                      {canEdit && (
                        <Link
                          to={`/cellars/${id}/import`}
                          className="more-menu-item"
                          data-guide="cellar-import"
                          onClick={() => setMoreOpen(false)}
                        >
                          <span aria-hidden="true">📥</span> Import Bottles
                        </Link>
                      )}
                      {cellar.userRole === 'owner' && (
                        <button
                          className="more-menu-item"
                          onClick={async () => {
                            setMoreOpen(false);
                            try {
                              const res = await exportCellar(apiFetch, id);
                              const data = await res.json();
                              if (!res.ok) { alert(data.error || 'Export failed'); return; }
                              downloadBlob(JSON.stringify(data.bottles, null, 2), `${data.cellarName || 'cellar'}-export.json`, 'application/json');
                            } catch { alert('Export failed'); }
                          }}
                        >
                          <span aria-hidden="true">📤</span> Export (JSON)
                        </button>
                      )}
                      {cellar.userRole === 'owner' && (
                        <button
                          className="more-menu-item"
                          onClick={async () => {
                            setMoreOpen(false);
                            try {
                              const res = await exportCellar(apiFetch, id);
                              const data = await res.json();
                              if (!res.ok) { alert(data.error || 'Export failed'); return; }
                              const bottles = data.bottles;
                              if (bottles.length === 0) { alert('No bottles to export'); return; }
                              const cols = ['wineName','producer','vintage','country','region','appellation','type',
                                'price','currency','bottleSize','purchaseDate','purchaseLocation','location',
                                'notes','rating','ratingScale','drinkFrom','drinkBefore',
                                'rackName','rackPosition','rackRow','rackCol','dateAdded',
                                'addToHistory','consumedReason','consumedAt','consumedNote','consumedRating','consumedRatingScale'];
                              const escape = v => {
                                if (v == null || v === '') return '';
                                const s = String(v);
                                return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
                              };
                              const csv = [cols.join(','), ...bottles.map(b => cols.map(c => escape(b[c])).join(','))].join('\n');
                              downloadBlob(csv, `${data.cellarName || 'cellar'}-export.csv`, 'text/csv');
                            } catch { alert('Export failed'); }
                          }}
                        >
                          <span aria-hidden="true">📄</span> Export (CSV)
                        </button>
                      )}
                      {cellar.userRole === 'owner' && (
                        <Link
                          to={`/cellars/${id}/audit`}
                          className="more-menu-item"
                          onClick={() => setMoreOpen(false)}
                        >
                          <span aria-hidden="true">📋</span> {t('cellarDetail.auditLog')}
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
            </div>
          )}
        </div>

        {loading ? (
          <div className="skeleton-h1" />
        ) : (
          <>
            <h1 className={h1Class} style={h1Style}>{cellar.name}</h1>
            {cellar.description && <p className="cellar-description">{cellar.description}</p>}
            {cellar.userRole && cellar.userRole !== 'owner' && (
              <p className="shared-by-label">
                {t('cellarDetail.sharedBy')} <strong>{cellar.user?.username}</strong>
                {' · '}
                <span className={`shared-role-tag shared-role-tag--${cellar.userRole}`}>
                  {cellar.userRole === 'editor' ? t('cellarDetail.editAccess') : t('cellarDetail.viewAccess')}
                </span>
              </p>
            )}
          </>
        )}
      </div>

      {/* ── Segmented tabs ── */}
      <div className="cellar-tabs">
        <button
          className={`cellar-tab ${activeTab === 'bottles' ? 'active' : ''}`}
          onClick={() => setActiveTab('bottles')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          Bottles
          {statistics && <span className="tab-count">{statistics.totalBottles}</span>}
        </button>
        <button
          className={`cellar-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          Overview
        </button>
      </div>

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

          {/* Quick links */}
          <div className="overview-links">
            <Link to={`/cellars/${id}/racks`} className="overview-link-card">
              <span className="overview-link-icon" aria-hidden="true">🗄️</span>
              <div>
                <strong>{t('cellarDetail.racks')}</strong>
                <span>View rack layout</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
            <Link to={`/cellars/${id}/room`} className="overview-link-card" data-guide="cellar-room">
              <span className="overview-link-icon" aria-hidden="true">🏠</span>
              <div>
                <strong>{t('cellarDetail.roomView', 'Room View')} <span className="overview-beta-badge">Beta</span></strong>
                <span>{t('cellarDetail.roomViewDesc', '3D cellar layout')}</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
            {cellar.userRole === 'owner' && (
              <Link to={`/cellars/${id}/wine-lists`} className="overview-link-card">
                <span className="overview-link-icon" aria-hidden="true">📋</span>
                <div>
                  <strong>Wine Lists</strong>
                  <span>Create PDF menus</span>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
              </Link>
            )}
            <Link to={`/cellars/${id}/history`} className="overview-link-card">
              <span className="overview-link-icon" aria-hidden="true">📖</span>
              <div>
                <strong>{t('cellarDetail.history')}</strong>
                <span>Consumed bottles</span>
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
            (filters.grapes || []).forEach(v => activeChips.push({ key: 'grapes', value: v, label: grapeNames[v] || v }));
            (filters.vintage || []).forEach(v => activeChips.push({ key: 'vintage', value: v, label: v }));
            if (filters.minRating) activeChips.push({ key: 'minRating', value: filters.minRating, label: `${filters.minRating}+ rating` });
            if (filters.maturity) activeChips.push({ key: 'maturity', value: filters.maturity, label: filters.maturity });

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
              type: [], country: [], region: [], grapes: [], vintage: [],
              minRating: '', maturity: ''
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
                    aria-label="Sort bottles"
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
                          aria-label={`Remove ${chip.label}`}
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
                    />
                  </Suspense>
                )}
              </>
            );
          })()}

          {loading ? (
            <div className="loading">{t('cellarDetail.loadingCellar')}</div>
          ) : bottles.length === 0 && !bottlesLoading ? (
            (filters.search || filters.vintage?.length || filters.minRating || filters.maturity || filters.type?.length || filters.country?.length || filters.region?.length || filters.grapes?.length) ? (
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
              rackMap={rackMap}
              cellarId={id}
              hasMore={bottles.length < bottlesTotal}
              loadingMore={bottlesLoading}
              onLoadMore={loadMore}
            />
          )}
        </div>
      )}

      {/* ── FAB: Add Bottle (mobile only) ── */}
      {!loading && canEdit && (
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
function BottlesList({ bottles, rackMap, cellarId, hasMore, loadingMore, onLoadMore }) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('cellarion_bottle_view') || 'list'; } catch { return 'list'; }
  });

  const setView = (mode) => {
    setViewMode(mode);
    try { localStorage.setItem('cellarion_bottle_view', mode); } catch {}
  };

  return (
    <>
      <div className="bottles-view-toggle">
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
      </div>

      <div className={viewMode === 'list' ? 'bottles-list' : 'bottles-grid'}>
        {bottles.map(bottle => (
          <BottleCard
            key={bottle._id}
            bottle={bottle}
            rackMap={rackMap}
            cellarId={cellarId}
            viewMode={viewMode}
          />
        ))}
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
  );
}

export default CellarDetail;
