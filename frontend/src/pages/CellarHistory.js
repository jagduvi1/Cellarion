import { useState, useEffect, useRef, useMemo, Suspense } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { useParams, Link } from 'react-router-dom';
import { useCameBack } from '../utils/useBackHere';
import { validScope, keepKnownCellars } from '../utils/savedScope';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import RatingDisplay from '../components/RatingDisplay';
import WineImage from '../components/WineImage';
import BottleFilterModal from '../components/BottleFilterModal';
import { addToWishlist } from '../api/wishlist';
import { restoreBottle } from '../api/bottles';
import { listCellars, getCellarHistory, getMultiCellarHistory } from '../api/cellars';
import { withinRestoreWindow } from '../utils/restoreWindow';
import { messageForResponse, friendlyError } from '../utils/friendlyError';
import { bottleNoticeName } from '../components/BottleUndoNotice';
import CellarScopePicker from '../components/CellarScopePicker';
import CellarNav from '../components/CellarNav';
import CellarPageHeader from '../components/CellarPageHeader';
import SearchInput from '../components/SearchInput';
import './CellarDetail.css';
import './CellarHistory.css';
import '../components/BottleUndoNotice.css';

const AddMoreBottlesModal = lazy(() => import('../components/AddMoreBottlesModal'));

// Bottles per page. The first page is the newest bottles of every section; a
// section's "Load more" continues after the last bottle it shows.
const PAGE_SIZE = 50;

const REASON_CONFIG = {
  drank:  { icon: '🍷', className: 'drank' },
  gifted: { icon: '🎁', className: 'gifted' },
  sold:   { icon: '💰', className: 'sold' },
  other:  { icon: '📦', className: 'other' },
};

// Which section a bottle is listed in (the server counts them the same way).
const reasonOf = (bottle) => {
  const reason = bottle.consumedReason || bottle.status;
  return REASON_CONFIG[reason] ? reason : 'other';
};
// Where a section's next page starts: after this bottle (?before).
const cursorOf = (bottle) => `${bottle.consumedAt || ''}|${bottle._id}`;

// What the history view was showing — search, filters and scope — kept per
// cellar for this tab, so Back from a bottle finds the same list (it used to
// start over: everything in component state only). Only Back/Forward (or a
// reload) restores it — a link to the history opens it fresh.
const HISTORY_VIEW_PREFIX = 'cellarion.historyView.';
const DEFAULT_HISTORY_FILTERS = {
  search: '',
  type: [], country: [], region: [], grapes: [], vintage: [],
  minRating: '', maxRating: '', maturity: []
};
const readSavedHistoryView = (cellarId) => {
  try {
    const v = JSON.parse(sessionStorage.getItem(HISTORY_VIEW_PREFIX + cellarId) || 'null');
    if (!v || typeof v !== 'object') return null;
    return { filters: { ...DEFAULT_HISTORY_FILTERS, ...(v.filters || {}) }, scope: validScope(v.scope, cellarId) };
  } catch {
    return null;
  }
};

function CellarHistory() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user } = useAuth();
  const [cellar, setCellar] = useState(null);
  // The pages loaded so far, and the server's totals for the whole history.
  const [bottles, setBottles] = useState([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  // A new first page is on its way (search, filters or scope changed).
  const [refreshing, setRefreshing] = useState(false);
  // The section whose next page is on its way, if any.
  const [loadingMore, setLoadingMore] = useState(null);
  // Per section: where its next page starts, and — once a "Load more" has
  // answered — how many bottles are left after what it shows.
  const [sections, setSections] = useState({});
  const [error, setError] = useState(null);
  const [total, setTotal] = useState(0);
  // Whether the list on screen was asked for with a search or a filter: an
  // empty answer then means "nothing matches", not "nothing taken out yet".
  // Kept with the answer, not read off the search box, so the empty state
  // never flashes the wrong message while a new answer is on its way.
  const [shownNarrowed, setShownNarrowed] = useState(false);
  const [reasonCounts, setReasonCounts] = useState(null);
  const cameBack = useCameBack();
  const [savedView] = useState(() => (cameBack ? readSavedHistoryView(id) : null));
  const [filters, setFilters] = useState(() => savedView?.filters || DEFAULT_HISTORY_FILTERS);
  const [facets, setFacets] = useState(null);
  const [baseFacets, setBaseFacets] = useState(null);
  const [facetMeta, setFacetMeta] = useState(null);
  const [showFilterModal, setShowFilterModal] = useState(false);
  // What a card's "Move back to cellar" or "Add again" just did, said in the
  // floating line (the card may be far down a long history).
  const [notice, setNotice] = useState(null);
  // The bottle "Add again" copies (components/AddMoreBottlesModal).
  const [addTemplate, setAddTemplate] = useState(null);

  // ── Cross-cellar scope: which cellars this history view spans (default: this one) ──
  const [allCellars, setAllCellars] = useState([]);
  const [scopeIds, setScopeIds] = useState(() => savedView?.scope || [id]);
  const scopeKey = scopeIds.join(',');
  const isMulti = !(scopeIds.length === 1 && scopeIds[0] === id);

  useEffect(() => {
    listCellars(apiFetch)
      .then(r => r.json())
      .then(d => {
        const list = d.cellars || [];
        setAllCellars(list);
        // A remembered scope may name a cellar since deleted or unshared —
        // judged only on a real answer (an error must not wipe the scope).
        if (Array.isArray(d.cellars)) setScopeIds((prev) => keepKnownCellars(prev, id, list));
      })
      .catch(() => {});
  }, [apiFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the scope to just this cellar whenever the user navigates to a
  // different cellar's history (the filters carry over) — unless coming back
  // to it, when its own remembered view returns.
  const historyFirstRun = useRef(true);
  useEffect(() => {
    if (historyFirstRun.current) { historyFirstRun.current = false; return; }
    const view = cameBack ? readSavedHistoryView(id) : null;
    setScopeIds(view?.scope || [id]);
    if (view) setFilters(view.filters);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      sessionStorage.setItem(HISTORY_VIEW_PREFIX + id, JSON.stringify({ filters, scope: scopeIds }));
    } catch { /* best-effort */ }
  }, [id, filters, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Monotonic fetch token — only the most-recent fetch commits its result, so an
  // out-of-order response from a superseded scope/filter can't overwrite newer data.
  // A "Load more" answer also counts only while no newer list has been asked for.
  const fetchSeq = useRef(0);
  // What the list on screen was asked with, for its sections' next pages.
  const listQuery = useRef(null);

  // Debounce search
  const [debouncedSearch, setDebouncedSearch] = useState(() => filters.search || '');
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

  // `id` is included so navigating to another cellar whose scope key matches the
  // current one still refetches; the fetch-seq guard drops the transient
  // stale-scope response produced by the id→scope-reset.
  useEffect(() => {
    fetchHistory();
  }, [id, filterKey, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestHistory = (query, params) => (query.multi
    ? getMultiCellarHistory(apiFetch, params.toString())
    : getCellarHistory(apiFetch, query.cellarId, params.toString()));

  // The first page: the newest bottles of every section, and the totals.
  const fetchHistory = async () => {
    const seq = ++fetchSeq.current;
    setError(null);
    setRefreshing(true);
    setLoadingMore(null);
    try {
      const filterParams = new URLSearchParams();
      if (debouncedSearch) filterParams.append('search', debouncedSearch);
      Object.entries(filters).forEach(([key, val]) => {
        if (key === 'search') return;
        if (Array.isArray(val) && val.length > 0) filterParams.append(key, val.join(','));
      });
      const asked = [...filterParams.keys()].length > 0;
      const multi = !(scopeIds.length === 1 && scopeIds[0] === id);
      if (multi) filterParams.append('cellars', scopeIds.join(','));
      const query = { multi, cellarId: id, filters: filterParams.toString() };
      const params = new URLSearchParams(query.filters);
      params.append('limit', String(PAGE_SIZE));
      const res = await requestHistory(query, params);
      const data = await res.json();
      // Superseded by a newer fetch — drop this response.
      if (seq !== fetchSeq.current) return;
      if (!res.ok) { setError(data.error || 'Failed to load history'); return; }

      if (data.cellar) setCellar(data.cellar);
      const page = data.bottles || [];
      listQuery.current = query;
      // A server from before paging sends the whole history and no total.
      setTotal(typeof data.total === 'number' ? data.total : page.length);
      setShownNarrowed(asked);
      setReasonCounts(data.reasonCounts || null);
      setBottles(page);
      const next = {};
      for (const bottle of page) next[reasonOf(bottle)] = { cursor: cursorOf(bottle) };
      setSections(next);
      setHasLoaded(true);
      setFacets(data.facets ?? null); // none sent: no counts, not stale ones
      if (data.baseFacets) setBaseFacets(data.baseFacets);
      if (data.facetMeta) setFacetMeta(data.facetMeta);
    } catch {
      if (seq === fetchSeq.current) setError('Network error');
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  // A section's next page, after the last bottle it shows. The answer is
  // dropped if a new list was asked for meanwhile.
  const loadMore = async (reason) => {
    const seq = fetchSeq.current;
    const query = listQuery.current;
    if (!query) return;
    setError(null);
    setLoadingMore(reason);
    try {
      const params = new URLSearchParams(query.filters);
      params.append('limit', String(PAGE_SIZE));
      params.append('reason', reason);
      const cursor = sections[reason]?.cursor;
      if (cursor) params.append('before', cursor);
      const res = await requestHistory(query, params);
      const data = await res.json();
      // Dropped if a new list was asked for meanwhile, or is already on screen.
      if (seq !== fetchSeq.current || listQuery.current !== query) return;
      if (!res.ok) { setError(data.error || 'Failed to load history'); return; }

      const page = data.bottles || [];
      // A bottle already listed (moved in the order since, say) isn't repeated.
      setBottles(prev => {
        const listed = new Set(prev.map(b => b._id));
        return [...prev, ...page.filter(b => !listed.has(b._id))];
      });
      setSections(prev => ({
        ...prev,
        [reason]: {
          cursor: page.length ? cursorOf(page[page.length - 1]) : prev[reason]?.cursor,
          remaining: page.length && typeof data.remaining === 'number' ? data.remaining : 0,
        },
      }));
    } catch {
      if (seq === fetchSeq.current) setError('Network error');
    } finally {
      if (seq === fetchSeq.current) setLoadingMore(null);
    }
  };

  // Group the loaded bottles by reason.
  const grouped = useMemo(() => {
    const groups = { drank: [], gifted: [], sold: [], other: [] };
    bottles.forEach(bottle => groups[reasonOf(bottle)].push(bottle));
    return groups;
  }, [bottles]);
  // Per-reason counts for the whole history (the server's), else what is loaded.
  const countOf = (key) => (reasonCounts ? reasonCounts[key] || 0 : grouped[key].length);
  // More to load in a section: what its last "Load more" said is left, else
  // the count against what the first page brought.
  const hasMoreIn = (key) => {
    const remaining = sections[key]?.remaining;
    return typeof remaining === 'number' ? remaining > 0 : countOf(key) > grouped[key].length;
  };
  const busy = refreshing || loadingMore !== null;

  // Owners and editors of a bottle's own cellar may move it back or add it
  // again, as on the bottle page — the cross-cellar view spans several.
  const roleIn = (cellarId) => (String(cellarId) === String(id) && cellar?.userRole)
    || allCellars.find((c) => String(c._id) === String(cellarId))?.userRole;
  const canEditIn = (cellarId) => ['owner', 'editor'].includes(roleIn(cellarId || id));
  // A bottle moved back leaves the list where it is — the pages "Load more"
  // brought stay, and the totals drop by one — rather than the history
  // starting over from its first page.
  const handleRestored = (bottle) => {
    setNotice(t('bottleNotice.restored', '“{{name}}” is back in the cellar.', { name: bottleNoticeName(bottle) || t('bottleNotice.thisBottle', 'The bottle') }));
    const reason = reasonOf(bottle);
    setBottles((prev) => prev.filter((b) => b._id !== bottle._id));
    setTotal((n) => Math.max(0, n - 1));
    setReasonCounts((prev) => (prev ? { ...prev, [reason]: Math.max(0, (prev[reason] || 0) - 1) } : prev));
  };

  // Only replace the whole page when nothing has loaded yet; after a successful
  // load, transient fetch failures render as an inline banner instead.
  const hasLoadedContent = hasLoaded;
  if (error && !hasLoadedContent) return <div className="alert alert-error">{error}</div>;

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

  // Something narrows the list — a filter chip or the search box (which has
  // no chip, so a search that found nothing used to show the empty-history
  // note). Read from the answer on screen (shownNarrowed).
  const narrowed = shownNarrowed;

  const removeChip = (chip) => {
    setFilters(prev => {
      const val = prev[chip.key];
      if (Array.isArray(val)) return { ...prev, [chip.key]: val.filter(v => v !== chip.value) };
      return { ...prev, [chip.key]: '' };
    });
  };

  const clearAll = () => setFilters(prev => ({
    ...prev, type: [], country: [], region: [], grapes: [], vintage: [],
    minRating: '', maxRating: '', maturity: []
  }));

  return (
    <div className="cellar-history-page">
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
      {notice && (
        <div className="alert alert-success bottle-undo-notice bottle-undo-notice--floating" role="status">
          <span className="bottle-undo-notice__text">{notice}</span>
          <button
            type="button"
            className="btn btn-small btn-secondary bottle-undo-notice__close"
            onClick={() => setNotice(null)}
            aria-label={t('common.close', 'Close')}
          >
            ✕
          </button>
        </div>
      )}
      <CellarPageHeader
        backTo={`/cellars/${id}`}
        backLabel={t('history.backTo', { cellarName: cellar?.name || '…' })}
        title={t('history.title')}
        loading={loading}
        userColor={cellar?.userColor}
        subtitle={total === 0 && !narrowed ? t('history.noHistory') : t('history.bottleCount', { count: total })}
      />

      <CellarNav cellarId={id} active="history" />

      {loading ? (
        <div className="loading">{t('history.loadingHistory')}</div>
      ) : <>

      {/* Summary row */}
      {total > 0 && !narrowed && (
        <div className="history-summary-row">
          {Object.entries(REASON_CONFIG).map(([key, cfg]) => {
            const count = countOf(key);
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
        <SearchInput
          placeholder={t('cellarDetail.searchPlaceholder')}
          value={filters.search}
          onChange={search => setFilters({ ...filters, search })}
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
        {allCellars.length > 1 && (
          <CellarScopePicker
            cellars={allCellars}
            value={scopeIds}
            currentCellarId={id}
            onChange={setScopeIds}
          />
        )}
      </div>

      {/* Active filter chips */}
      {activeChips.length > 0 && (
        <div className="active-filters-row">
          {activeChips.map((chip, i) => (
            <span key={`${chip.key}-${chip.value}-${i}`} className="active-filter-chip">
              {chip.label}
              <button type="button" className="active-filter-chip-remove" onClick={() => removeChip(chip)} aria-label={t('cellarDetail.removeFilterAria', { label: chip.label })}>×</button>
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
          showRatingMaturity={false}
        />
      )}

      {total === 0 && !narrowed && (
        <div className="empty-state">
          <p>{t('history.emptyHistoryHint')}</p>
          <Link to={`/cellars/${id}`} className="btn btn-primary">{t('history.backToCellarBtn')}</Link>
        </div>
      )}

      {total === 0 && narrowed && (
        <div className="empty-state">
          <p>{t('cellarDetail.noSearchResults')}</p>
        </div>
      )}

      {(() => {
        let anyVisible = false;
        const sectionList = Object.entries(REASON_CONFIG).map(([key, cfg]) => {
          const items = grouped[key] || [];
          // A section whose bottles aren't loaded yet still shows, with its count.
          if (items.length === 0 && countOf(key) === 0) return null;
          anyVisible = true;
          return (
            <section key={key} className={`history-section ${cfg.className}`}>
              <div className="history-section-header">
                <span className="history-section-icon">{cfg.icon}</span>
                <h2>{t(REASON_LABEL_KEYS[key])} <span className="section-count">({countOf(key)})</span></h2>
              </div>
              {items.length > 0 && (
                <div className="history-bottles">
                  {items.map(bottle => {
                    const canEdit = canEditIn(bottle.cellar);
                    return (
                      <HistoryBottleCard
                        key={bottle._id}
                        bottle={bottle}
                        cellarId={id}
                        showCellarBadge={isMulti}
                        canEdit={canEdit}
                        onRestored={handleRestored}
                        onAddAgain={canEdit && bottle.wineDefinition?._id && !user?.isDemo ? setAddTemplate : undefined}
                      />
                    );
                  })}
                </div>
              )}
              {hasMoreIn(key) && (
                <div className="load-more-wrap">
                  <button type="button" className="btn btn-secondary" onClick={() => loadMore(key)} disabled={busy}>
                    {loadingMore === key ? t('common.loading') : t('cellarDetail.loadMore')}
                  </button>
                </div>
              )}
            </section>
          );
        });

        if (filters.search && !anyVisible && total > 0) {
          return <p className="history-no-results">{t('history.noResults')}</p>;
        }
        return sectionList;
      })()}

      </>}

      <Suspense fallback={null}>
        {addTemplate && (
          <AddMoreBottlesModal
            bottle={addTemplate}
            copyDetailsDefault={false}
            onClose={() => setAddTemplate(null)}
            onAdded={(count) => {
              const name = bottleNoticeName(addTemplate);
              setAddTemplate(null);
              setNotice(name
                ? t('bottleNotice.added', { count, name })
                : t('bottleNotice.addedUnnamed', { count }));
            }}
          />
        )}
      </Suspense>
    </div>
  );
}

function HistoryBottleCard({ bottle, cellarId, showCellarBadge = false, canEdit = false, onRestored, onAddAgain }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const wine = bottle.wineDefinition;
  // In the cross-cellar view each row belongs to its own cellar; fall back to
  // the page's cellar id for the single-cellar view.
  const linkCellarId = bottle.cellar || cellarId;
  const cellarBadge = showCellarBadge && bottle.cellarName ? bottle.cellarName : null;
  const consumedDate = bottle.consumedAt
    ? new Date(bottle.consumedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  // One-tap add-to-wishlist: 'idle' → 'saving' → 'added' | 'error'.
  const [wishState, setWishState] = useState('idle');

  // "Move back to cellar" — the bottle page's restore, here too: a drink
  // logged by mistake was only undoable from the bottle's own page. Same
  // two-day window (utils/restoreWindow) and the same refusal from the server.
  const canRestore = canEdit && withinRestoreWindow(bottle);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const handleRestore = async () => {
    if (restoreBusy) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const res = await restoreBottle(apiFetch, bottle._id);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server's reason ("removed too long ago…"), or for a rate limit
        // or an outage words with the wait — utils/friendlyError.
        setRestoreError(messageForResponse(res, data, t('bottleDetail.restoreError', 'Could not move it back — try again'), t));
        return;
      }
      onRestored?.(bottle);
    } catch (err) {
      setRestoreError(friendlyError(err, t));
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleAddToWishlist = async (e) => {
    // The button is a sibling of the stretched-link overlay (not nested), but
    // stop the event anyway so a stray bubble can never trigger navigation.
    e.preventDefault();
    e.stopPropagation();
    if (!wine?._id || wishState === 'saving' || wishState === 'added') return;
    setWishState('saving');
    try {
      const res = await addToWishlist(apiFetch, {
        wineDefinitionId: wine._id,
        vintage: bottle.vintage || undefined,
      });
      // 201 = created, 409 = already on the wishlist — both mean "it's there".
      setWishState(res.ok || res.status === 409 ? 'added' : 'error');
    } catch {
      setWishState('error');
    }
  };

  const wishLabel = wishState === 'added'
    ? t('history.onWishlist')
    : wishState === 'saving'
      ? t('history.addingToWishlist')
      : wishState === 'error'
        ? t('history.wishlistError')
        : t('history.addToWishlist');

  return (
    <div className={`history-bottle-card ${bottle.consumedReason || bottle.status}`}>
      {/* Stretched link: keeps the whole card an openable anchor while the
          wishlist button lives beside it (no <button> nested inside an <a>). */}
      <Link
        to={`/cellars/${linkCellarId}/bottles/${bottle._id}`}
        state={{ fromHistory: true }}
        className="history-bottle-card__overlay"
        aria-label={t('history.viewBottleAria', { name: wine?.name || t('common.unknownWine') })}
      />

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
          {cellarBadge && (
            <span className="history-cellar-badge">
              <span
                className="history-cellar-badge-dot"
                style={bottle.cellarColor ? { background: bottle.cellarColor } : undefined}
                aria-hidden="true"
              />
              {cellarBadge}
            </span>
          )}
        </div>
        <div className="history-bottle-main-right">
          {/* The vintage page stays reachable after the last bottle is drunk
              (support ticket 2026-10-09): from here, not only from the cellar
              list's group, which is gone by then. */}
          {wine?._id && (
            <Link
              to={`/cellars/${linkCellarId}/vintages/${wine._id}/${encodeURIComponent(bottle.vintage || 'NV')}`}
              className="history-vintage-link"
              onClick={(e) => e.stopPropagation()}
            >
              {t('history.vintagePage', 'Vintage page')}
            </Link>
          )}
          {/* "Add again": new bottles of this wine and vintage, copied from
              this one, straight into the cellar — the visible way back used to
              be the wishlist, which never adds a bottle. */}
          {onAddAgain && (
            <button
              type="button"
              className="history-card-btn"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onAddAgain(bottle); }}
              title={t('bottleDetail.addAgainHint', 'Bought it again? Add new bottles of this wine and vintage to the cellar.')}
              aria-label={t('bottleDetail.addAgain', 'Add again')}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span className="history-card-btn-label">{t('bottleDetail.addAgain', 'Add again')}</span>
            </button>
          )}
          {wine?._id && (
            <button
              type="button"
              className={`history-add-wishlist-btn is-${wishState}`}
              onClick={handleAddToWishlist}
              disabled={wishState === 'saving' || wishState === 'added'}
              title={wishState === 'added' ? t('history.onWishlist') : t('history.addToWishlist')}
            >
              {wishState === 'added' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              )}
              <span className="history-add-wishlist-label">{wishLabel}</span>
            </button>
          )}
          <svg className="history-bottle-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
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

      {canRestore && (
        <div className="history-restore-row">
          <button type="button" className="history-card-btn" onClick={handleRestore} disabled={restoreBusy}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/>
            </svg>
            {restoreBusy ? t('bottleDetail.restoring', 'Moving back…') : t('bottleDetail.restore', 'Move back to cellar')}
          </button>
          <span className="history-restore-hint">{t('bottleDetail.restoreHint', 'Removed by mistake? Put it back as active (within 2 days).')}</span>
          {restoreError && <span className="history-restore-error" role="alert">{restoreError}</span>}
        </div>
      )}
    </div>
  );
}

export default CellarHistory;
