import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import RatingDisplay from '../components/RatingDisplay';
import WineImage from '../components/WineImage';
import BottleFilterModal from '../components/BottleFilterModal';
import './CellarHistory.css';

const REASON_CONFIG = {
  drank:  { icon: '🍷', className: 'drank' },
  gifted: { icon: '🎁', className: 'gifted' },
  sold:   { icon: '💰', className: 'sold' },
  other:  { icon: '📦', className: 'other' },
};

function CellarHistory() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user } = useAuth();
  const [cellar, setCellar] = useState(null);
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    search: '',
    type: [], country: [], region: [], grapes: [], vintage: [],
    minRating: '', maturity: ''
  });
  const [facets, setFacets] = useState(null);
  const [baseFacets, setBaseFacets] = useState(null);
  const [facetMeta, setFacetMeta] = useState(null);
  const [showFilterModal, setShowFilterModal] = useState(false);

  // Debounce search
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimer = useRef(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(filters.search), 350);
    return () => clearTimeout(searchTimer.current);
  }, [filters.search]);

  // Serialize filters for dependency
  const filterKey = [
    debouncedSearch,
    filters.type.join(','), filters.country.join(','), filters.region.join(','),
    filters.grapes.join(','), filters.vintage.join(',')
  ].join('|');

  useEffect(() => {
    fetchHistory();
  }, [id, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchHistory = async () => {
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.append('search', debouncedSearch);
      Object.entries(filters).forEach(([key, val]) => {
        if (key === 'search') return;
        if (Array.isArray(val) && val.length > 0) params.append(key, val.join(','));
      });
      const qs = params.toString();
      const res = await apiFetch(`/api/cellars/${id}/history${qs ? `?${qs}` : ''}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to load history'); return; }

      setCellar(data.cellar);
      setTotal(data.bottles.length);
      if (data.facets) setFacets(data.facets);
      if (data.baseFacets) setBaseFacets(data.baseFacets);
      if (data.facetMeta) setFacetMeta(data.facetMeta);

      // Group by reason
      const groups = { drank: [], gifted: [], sold: [], other: [] };
      (data.bottles || []).forEach(bottle => {
        const reason = bottle.consumedReason || bottle.status;
        if (groups[reason]) groups[reason].push(bottle);
        else groups.other.push(bottle);
      });
      setGrouped(groups);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  if (error) return <div className="alert alert-error">{error}</div>;

  const REASON_LABEL_KEYS = {
    drank:  'history.reasonDrank',
    gifted: 'history.reasonGifted',
    sold:   'history.reasonSold',
    other:  'history.reasonOther',
  };

  // Build active filter chips
  const reverseMap = (map) => {
    const rev = {};
    if (map) Object.entries(map).forEach(([name, fid]) => { rev[fid] = name; });
    return rev;
  };
  const countryNames = reverseMap(facetMeta?.countries);
  const regionNames = reverseMap(facetMeta?.regions);
  const grapeNames = reverseMap(facetMeta?.grapes);

  const activeChips = [];
  (filters.type || []).forEach(v => activeChips.push({ key: 'type', value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
  (filters.country || []).forEach(v => activeChips.push({ key: 'country', value: v, label: countryNames[v] || v }));
  (filters.region || []).forEach(v => activeChips.push({ key: 'region', value: v, label: regionNames[v] || v }));
  (filters.grapes || []).forEach(v => activeChips.push({ key: 'grapes', value: v, label: grapeNames[v] || v }));
  (filters.vintage || []).forEach(v => activeChips.push({ key: 'vintage', value: v, label: v }));

  const removeChip = (chip) => {
    setFilters(prev => {
      const val = prev[chip.key];
      if (Array.isArray(val)) return { ...prev, [chip.key]: val.filter(v => v !== chip.value) };
      return { ...prev, [chip.key]: '' };
    });
  };

  const clearAll = () => setFilters(prev => ({
    ...prev, type: [], country: [], region: [], grapes: [], vintage: [],
    minRating: '', maturity: ''
  }));

  return (
    <div className="cellar-history-page">
      <div className="history-header">
        <Link to={`/cellars/${id}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          {t('history.backTo', { cellarName: cellar?.name || '…' })}
        </Link>
        {loading ? (
          <div className="skeleton-h1" />
        ) : (
          <>
            <h1 className={cellar?.userColor ? 'cellar-accent-border' : ''} style={cellar?.userColor ? { '--cellar-color': cellar.userColor } : undefined}>
              {t('history.title')}
            </h1>
            <p className="page-subtitle">
              {total === 0 && !activeChips.length
                ? t('history.noHistory')
                : t('history.bottleCount', { count: total })}
            </p>
          </>
        )}
      </div>

      {loading ? (
        <div className="loading">{t('history.loadingHistory')}</div>
      ) : <>

      {/* Summary row */}
      {total > 0 && !activeChips.length && (
        <div className="history-summary-row">
          {Object.entries(REASON_CONFIG).map(([key, cfg]) => {
            const count = grouped[key]?.length || 0;
            return (
              <div key={key} className={`history-summary-pill ${cfg.className} ${count === 0 ? 'empty' : ''}`}>
                <span>{cfg.icon}</span>
                <span className="pill-count">{count}</span>
                <span>{t(REASON_LABEL_KEYS[key])}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Search + filter bar — same layout as cellar bottles tab */}
      <div className="search-row history-search-row">
        <input
          type="text"
          className="search-input"
          placeholder={t('cellarDetail.searchPlaceholder')}
          value={filters.search}
          onChange={e => setFilters({ ...filters, search: e.target.value })}
          aria-label={t('cellarDetail.searchPlaceholder')}
        />
        <button
          type="button"
          className={`filter-toggle-btn${activeChips.length > 0 ? ' filter-toggle-btn--has-filters' : ''}`}
          onClick={() => setShowFilterModal(true)}
          aria-label={t('cellarDetail.toggleFilters')}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M2 4h16M5 10h10M8 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          {activeChips.length > 0 && (
            <span className="filter-badge">{activeChips.length}</span>
          )}
        </button>
      </div>

      {/* Active filter chips */}
      {activeChips.length > 0 && (
        <div className="active-filters-row">
          {activeChips.map((chip, i) => (
            <span key={`${chip.key}-${chip.value}-${i}`} className="active-filter-chip">
              {chip.label}
              <button type="button" className="active-filter-chip-remove" onClick={() => removeChip(chip)} aria-label={`Remove ${chip.label}`}>×</button>
            </span>
          ))}
          <button type="button" className="active-filters-clear" onClick={clearAll}>
            {t('cellarDetail.clearAllFilters')}
          </button>
        </div>
      )}

      {showFilterModal && (
        <BottleFilterModal
          filters={filters}
          onApply={setFilters}
          onClose={() => setShowFilterModal(false)}
          facets={facets}
          baseFacets={baseFacets}
          facetMeta={facetMeta}
          bottlesTotal={total}
        />
      )}

      {total === 0 && !activeChips.length && (
        <div className="empty-state">
          <p>{t('history.emptyHistoryHint')}</p>
          <Link to={`/cellars/${id}`} className="btn btn-primary">{t('history.backToCellarBtn')}</Link>
        </div>
      )}

      {total === 0 && activeChips.length > 0 && (
        <div className="empty-state">
          <p>{t('cellarDetail.noSearchResults')}</p>
        </div>
      )}

      {(() => {
        let anyVisible = false;
        const sections = Object.entries(REASON_CONFIG).map(([key, cfg]) => {
          const items = grouped[key] || [];
          if (items.length === 0) return null;
          anyVisible = true;
          return (
            <section key={key} className={`history-section ${cfg.className}`}>
              <div className="history-section-header">
                <span className="history-section-icon">{cfg.icon}</span>
                <h2>{t(REASON_LABEL_KEYS[key])} <span className="section-count">({items.length})</span></h2>
              </div>
              <div className="history-bottles">
                {items.map(bottle => (
                  <HistoryBottleCard key={bottle._id} bottle={bottle} cellarId={id} />
                ))}
              </div>
            </section>
          );
        });

        if (filters.search && !anyVisible && total > 0) {
          return <p className="history-no-results">{t('history.noResults', 'No bottles match your search.')}</p>;
        }
        return sections;
      })()}

      </>}
    </div>
  );
}

function HistoryBottleCard({ bottle, cellarId }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const wine = bottle.wineDefinition;
  const consumedDate = bottle.consumedAt
    ? new Date(bottle.consumedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  return (
    <Link
      to={`/cellars/${cellarId}/bottles/${bottle._id}`}
      state={{ fromHistory: true }}
      className={`history-bottle-card ${bottle.consumedReason || bottle.status}`}
    >
      <div className="history-bottle-main">
        <WineImage image={wine?.image} alt={wine?.name} className="history-bottle-image" />
        <div className="history-bottle-info">
          <h3>{wine?.name || t('common.unknownWine')}</h3>
          <p className="history-producer">{wine?.producer}</p>
          <div className="history-meta">
            <span>{t('history.vintageLabel')} {bottle.vintage}</span>
            {consumedDate && <span>· {consumedDate}</span>}
            {bottle.price && <span>· {t('history.paidLabel')} {bottle.price} {bottle.currency}</span>}
          </div>
        </div>
        <svg className="history-bottle-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>

      {/* Consumption details */}
      <div className="history-bottle-details">
        {bottle.consumedRating && (
          <div className="history-rating">
            <RatingDisplay value={bottle.consumedRating} scale={bottle.consumedRatingScale || '5'} preferredScale={user?.preferences?.ratingScale} />
            <span className="rating-label">{t('history.atConsumption')}</span>
          </div>
        )}
        {bottle.consumedNote && (
          <p className="history-note">"{bottle.consumedNote}"</p>
        )}
      </div>
    </Link>
  );
}

export default CellarHistory;
