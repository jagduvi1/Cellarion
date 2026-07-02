import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { listBottles } from '../api/bottles';
import BottleCard from '../components/BottleCard';
import './Bottles.css';

const FILTER_KEYS = [
  'search', 'type', 'country', 'region', 'grapes',
  'vintage', 'producer', 'bottleSize', 'minRating', 'maturity', 'sort',
  'purchaseYear', 'consumedYear', 'status',
];

const TYPE_LABELS = {
  red: 'Red', white: 'White', 'rosé': 'Rosé', sparkling: 'Sparkling',
  dessert: 'Dessert', fortified: 'Fortified',
};

const STATUS_LABELS = {
  active: 'Active',
  consumed: 'Consumed',
  all: 'All',
  drank: 'Drunk',
  gifted: 'Gifted',
  sold: 'Sold',
  other: 'Other',
};

const PAGE_SIZE = 30;

/**
 * Cross-cellar bottle list — typically reached by clicking a chart
 * segment on the Statistics page. The filter to apply is encoded in the
 * URL query params and the page is essentially read-only: the user lands
 * here with a specific filter pre-applied and can clear individual chips
 * or all of them to broaden the view.
 *
 * The set of bottles shown matches the Statistics page's scope: only
 * cellars the user OWNS (shared/read-only cellars are excluded), so a
 * count on the chart and the count of bottles here always agree.
 */
function Bottles() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo(() => {
    const out = {};
    for (const key of FILTER_KEYS) {
      const v = searchParams.get(key);
      if (v) out[key] = v;
    }
    return out;
  }, [searchParams]);

  const [page, setPage] = useState(0);
  const [data, setData] = useState({ items: [], total: 0, count: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Reset page when filters change so a new filter starts at the top. The
  // reset lands one render AFTER the filter change, so derive the effective
  // page for the current render — otherwise removing a chip while on page N
  // fires a request with the new filters but the stale offset, and its
  // response can arrive after (and clobber) the correct page-0 one.
  const filtersKey = searchParams.toString();
  const pageFiltersRef = useRef(filtersKey);
  const effectivePage = pageFiltersRef.current === filtersKey ? page : 0;
  useEffect(() => {
    if (pageFiltersRef.current !== filtersKey) {
      pageFiltersRef.current = filtersKey;
      setPage(0);
    }
  }, [filtersKey]);

  // Latest-wins guard for out-of-order responses between page changes.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listBottles(apiFetch, {
        ...filters,
        limit: PAGE_SIZE,
        offset: effectivePage * PAGE_SIZE,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load bottles');
      if (seq === loadSeq.current) {
        setData(json.bottles || { items: [], total: 0, count: 0 });
      }
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [apiFetch, filters, effectivePage]);

  useEffect(() => { load(); }, [load]);

  const removeFilter = (key) => {
    const next = new URLSearchParams(searchParams);
    next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const clearAll = () => {
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  // Build a friendly label for each active filter chip. We resolve
  // country/region/grape names from the populated bottle data we already
  // received, so we don't need an extra taxonomy fetch.
  const chipLabels = useMemo(() => {
    const labels = {};
    if (filters.type) labels.type = `Type: ${TYPE_LABELS[filters.type] || filters.type}`;
    if (filters.country) {
      const name = data.items.find(b => b.wineDefinition?.country?._id === filters.country)
        ?.wineDefinition?.country?.name;
      labels.country = `Country: ${name || filters.country}`;
    }
    if (filters.region) {
      const name = data.items.find(b => b.wineDefinition?.region?._id === filters.region)
        ?.wineDefinition?.region?.name;
      labels.region = `Region: ${name || filters.region}`;
    }
    if (filters.grapes) {
      const ids = String(filters.grapes).split(',');
      const names = ids.map(id => {
        for (const b of data.items) {
          const g = (b.wineDefinition?.grapes || []).find(g => g._id === id);
          if (g) return g.name;
        }
        return id;
      });
      labels.grapes = `Grape: ${names.join(', ')}`;
    }
    if (filters.vintage) labels.vintage = `Vintage: ${filters.vintage}`;
    if (filters.producer) labels.producer = `Producer: ${filters.producer}`;
    if (filters.bottleSize) labels.bottleSize = `Size: ${filters.bottleSize}`;
    if (filters.minRating) labels.minRating = `Rating: ${filters.minRating}+`;
    if (filters.maturity) labels.maturity = `Maturity: ${filters.maturity}`;
    if (filters.search) labels.search = `Search: "${filters.search}"`;
    if (filters.purchaseYear) labels.purchaseYear = `Purchased: ${filters.purchaseYear}`;
    if (filters.consumedYear) labels.consumedYear = `Consumed: ${filters.consumedYear}`;
    if (filters.status) labels.status = `Status: ${STATUS_LABELS[filters.status] || filters.status}`;
    return labels;
  }, [filters, data.items]);

  const chips = Object.entries(chipLabels);
  const total = data.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Build a rackMap so BottleCard's "Rack: …" line works. The cross-cellar
  // endpoint doesn't return rack details for performance, so we just hand
  // BottleCard an empty Map — it falls back gracefully.
  const rackMap = useMemo(() => new Map(), []);

  return (
    <div className="bottles-page">
      <div className="bottles-header">
        <div className="bottles-header-text">
          <h1>{t('bottles.title', 'All bottles')}</h1>
          <p className="bottles-subtitle">
            {loading
              ? t('bottles.loading', 'Loading…')
              : t('bottles.summary', '{{count}} of {{total}} bottles', { count: data.count, total })}
          </p>
        </div>
        <Link to="/statistics" className="btn btn-secondary btn-small">
          {t('bottles.backToStats', '← Back to Statistics')}
        </Link>
      </div>

      {chips.length > 0 && (
        <div className="bottles-chips-row">
          {chips.map(([key, label]) => (
            <span key={key} className="bottles-chip">
              {label}
              <button
                type="button"
                onClick={() => removeFilter(key)}
                aria-label={t('bottles.removeFilter', 'Remove this filter')}
                className="bottles-chip-remove"
              >
                ×
              </button>
            </span>
          ))}
          {chips.length > 1 && (
            <button type="button" className="bottles-chip-clear" onClick={clearAll}>
              {t('bottles.clearAll', 'Clear all')}
            </button>
          )}
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {!loading && data.items.length === 0 && !error && (
        <div className="bottles-empty">
          {chips.length > 0
            ? t('bottles.noneForFilters', 'No bottles match those filters.')
            : t('bottles.noneInCellar', 'No bottles in your cellars yet.')}
        </div>
      )}

      <div className="bottles-page-grid">
        {data.items.map(bottle => (
          <BottleCard
            key={bottle._id}
            bottle={bottle}
            rackMap={rackMap}
            cellarId={bottle.cellar}
            viewMode="card"
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="bottles-pagination">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage(p => Math.max(0, p - 1))}
          >
            ← {t('bottles.prev', 'Previous')}
          </button>
          <span className="bottles-page-indicator">
            {t('bottles.pageOf', 'Page {{page}} of {{total}}', { page: page + 1, total: totalPages })}
          </span>
          <button
            type="button"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            {t('bottles.next', 'Next')} →
          </button>
        </div>
      )}
    </div>
  );
}

export default Bottles;
