import { useState, useEffect, useRef, Suspense } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useCameBack } from '../utils/useBackHere';
import { validScope, keepKnownCellars } from '../utils/savedScope';
import useHandedOverState from '../hooks/useHandedOverState';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar, getCellarStatistics, getCellarMaturityCounts, listCellars, getMultiCellarBottles } from '../api/cellars';
import { getRacks } from '../api/racks';
import { getCellarLayout } from '../api/cellarLayout';
import BottleFilterModal from '../components/BottleFilterModal';
import CellarScopePicker from '../components/CellarScopePicker';
import ClimateCard from '../components/ClimateCard';
import CellarNav from '../components/CellarNav';
import CellarPageHeader from '../components/CellarPageHeader';
import SearchInput from '../components/SearchInput';
import { ratingRangeLabel, ratingBandName, toMaturityArray, MATURITY_I18N_KEY } from '../utils/filterLabels';
import { CELLAR_SORTS, DEFAULT_CELLAR_SORT, preferredCellarSort } from '../utils/cellarSort';
import { formatArrivalMonth, isArrivalLate } from '../utils/onOrder';
import BottleUndoNotice from '../components/BottleUndoNotice';
import OpenNowStrip from '../components/OpenNowStrip';
import BottleAddedNotice from '../components/BottleAddedNotice';
import LoadError from '../components/LoadError';
import BottlesList from '../components/cellar/BottlesList';
import './CellarDetail.css';

// Stable empty rack map for the cross-cellar view (rack placement is per-cellar,
// so it doesn't apply when several cellars are combined).
const EMPTY_RACKMAP = new Map();

// Lazy-load modals — they are heavy and only needed on user interaction
const ShareCellarModal = lazy(() => import('../components/ShareCellarModal'));
const EditCellarModal = lazy(() => import('../components/EditCellarModal').then(m => ({ default: m.EditCellarModal })));
const ColorPickerModal = lazy(() => import('../components/ColorPickerModal').then(m => ({ default: m.ColorPickerModal })));
const DeleteCellarModal = lazy(() => import('../components/DeleteCellarModal').then(m => ({ default: m.DeleteCellarModal })));
const RecentlyDeletedModal = lazy(() => import('../components/RecentlyDeletedModal'));

const BOTTLES_PER_PAGE = 30;
// Coming back to the list (Back from a bottle) should find it as it was left:
// the "all my cellars" scope, how many bottles were loaded, and where the page
// was scrolled. Per cellar, this tab only (sessionStorage), like the filters.
// Only Back/Forward (or a reload) restores them — a link to the cellar opens
// it fresh.
const SCOPE_STORAGE_PREFIX = 'cellarion.cellarScope.';
const PLACE_STORAGE_PREFIX = 'cellarion.cellarPlace.';
// The server's page cap (routes/cellars.js maxLimit): a place deeper than this
// comes back with its first 200 bottles and the rest behind "Load more".
const MAX_RESTORE = 200;
// A place older than this is a different visit, not a Back.
const PLACE_TTL_MS = 30 * 60 * 1000;
const readStored = (key) => {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
};
const readSavedScope = (cellarId) => validScope(readStored(SCOPE_STORAGE_PREFIX + cellarId), cellarId);

// Persist the per-cellar filter/sort selection for the tab session so that
// opening a bottle and hitting browser-back doesn't wipe it (the bottle page is
// a separate route, so CellarDetail unmounts and remounts on the way back).
// Deep-link URL params still take priority; this is only the fallback.
const FILTERS_STORAGE_PREFIX = 'cellarFilters:';
const buildDefaultFilters = (sort = DEFAULT_CELLAR_SORT) => ({
  search: '', type: [], country: [], region: [], appellation: [],
  grapes: [], vintage: [], minRating: '', maxRating: '', maturity: [], unplaced: '', reserved: '', storage: '',
  // Only set by Statistics chart deep links (no control in the filter modal);
  // shown as removable chips.
  producer: '', bottleSize: '', purchaseYear: '', ratingBand: '',
  sort
});
// Every URL param the page reads on arrival (and then clears from the URL).
// `scope=owned` widens the view to every cellar the user owns — how the
// Statistics page's chart segments land here.
const URL_FILTER_KEYS = ['search', 'type', 'country', 'region', 'appellation',
  'grapes', 'vintage', 'minRating', 'maxRating', 'maturity', 'unplaced', 'reserved', 'storage',
  'producer', 'bottleSize', 'purchaseYear', 'ratingBand', 'sort'];
const readSavedFilters = (cellarId) => {
  try {
    const raw = sessionStorage.getItem(FILTERS_STORAGE_PREFIX + cellarId);
    if (raw) {
      const saved = { ...buildDefaultFilters(), ...JSON.parse(raw) };
      // Selections saved before maturity became multi-select hold one string.
      saved.maturity = toMaturityArray(saved.maturity);
      return saved;
    }
  } catch { /* private mode / bad JSON — fall back to defaults */ }
  return null;
};

function CellarDetail() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user, updatePreferences } = useAuth();
  const ratingScale = user?.preferences?.ratingScale || '5';
  const userCurrency = user?.preferences?.currency || 'USD';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // A bottle the bottle page just took away (drunk, or "Added by mistake"),
  // said here with Undo — handed over once (hooks/useHandedOverState).
  const [bottleNotice, setBottleNotice] = useHandedOverState('bottleNotice');
  // "“X” added — Add another bottle", handed over by the add page. It gives
  // way to the next notice (a drink from a card): one line at a time.
  const [addedNotice, setAddedNotice] = useHandedOverState('addedNotice');
  useEffect(() => { if (bottleNotice) setAddedNotice(null); }, [bottleNotice]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cellar, setCellar] = useState(null);
  const [bottles, setBottles] = useState([]);
  // The open bottles in view (the first page's answer names them all,
  // whatever the filters), for the "Open now" strip.
  const [openBottles, setOpenBottles] = useState([]);
  const [bottlesTotal, setBottlesTotal] = useState(0);
  // Bottles behind the cards: identical bottles share a card, so `bottlesTotal`
  // (cards, for paging) can be 1 where the filter's button means 2 bottles.
  const [bottleCount, setBottleCount] = useState(0);
  // Bottles per maturity stage, for the filter's maturity buttons — asked for
  // each time the filter opens (#1291), kept with the cellar they are for:
  // { id, counts }.
  const [maturity, setMaturity] = useState(null);
  // { count, nextExpected } — bottles bought for this cellar, not arrived yet.
  const [onOrder, setOnOrder] = useState(null);
  const [statistics, setStatistics] = useState(null);
  const [rackMap, setRackMap] = useState(new Map());
  // null = rack layout not yet loaded. Gates the "Unplaced" badge: only badge
  // once we know the cellar has racks (true) — never while loading, and never
  // for cellars with no racks at all (false), where placement isn't a concept.
  const [hasRacks, setHasRacks] = useState(null);
  // [{ id, name, group }] for the "Stored in" filter
  const [storageRacks, setStorageRacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bottlesLoading, setBottlesLoading] = useState(false);
  const [error, setError] = useState(null);
  // Whether trying the load again can help: a network failure or a 5xx can; a
  // 404/403 ("Cellar not found") cannot, so it gets no Retry button.
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
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
    // A fresh visit opens in the sort the user picked last, on any cellar.
    const preferredSort = preferredCellarSort(user);
    const hasUrlFilters = URL_FILTER_KEYS.some(k => searchParams.has(k));
    if (!hasUrlFilters) return readSavedFilters(id) || buildDefaultFilters(preferredSort);
    return {
      search: searchParams.get('search') || '',
      type: searchParams.get('type')?.split(',').filter(Boolean) || [],
      country: searchParams.get('country')?.split(',').filter(Boolean) || [],
      region: searchParams.get('region')?.split(',').filter(Boolean) || [],
      appellation: searchParams.get('appellation')?.split(',').filter(Boolean) || [],
      grapes: searchParams.get('grapes')?.split(',').filter(Boolean) || [],
      vintage: searchParams.get('vintage')?.split(',').filter(Boolean) || [],
      minRating: searchParams.get('minRating') || '',
      maxRating: searchParams.get('maxRating') || '',
      // One bucket or several, comma-separated (OR) — e.g. ?maturity=late,declining
      maturity: toMaturityArray(searchParams.get('maturity')),
      unplaced: searchParams.get('unplaced') || '',
      reserved: searchParams.get('reserved') || '',
      // 'group:<name>' or 'rack:<id>' — where the bottle is stored
      storage: searchParams.get('storage') || '',
      producer: searchParams.get('producer') || '',
      bottleSize: searchParams.get('bottleSize') || '',
      purchaseYear: searchParams.get('purchaseYear') || '',
      // A statistics rating band ('61-80'): exactly the bottles counted in it.
      ratingBand: searchParams.get('ratingBand') || '',
      sort: searchParams.get('sort') || preferredSort
    };
  });
  // ?scope=owned (chart deep link): read once; applied when the cellar list
  // arrives. Until then the first fetch waits, so the page never flashes this
  // one cellar's bottles under an "all my cellars" filter.
  const [pendingOwnedScope, setPendingOwnedScope] = useState(() => searchParams.get('scope') === 'owned');
  const [facets, setFacets] = useState(null);
  const [baseFacets, setBaseFacets] = useState(null);
  const [facetMeta, setFacetMeta] = useState(null);
  // Identical bottles (same wine + vintage + size) are always collapsed into one
  // card. Server-side grouped (see ?group=1) so counts are correct across pagination.

  // ── Cross-cellar scope: which cellars this view spans (default: this one) ──
  const [allCellars, setAllCellars] = useState([]);
  const cameBack = useCameBack();
  const [scopeIds, setScopeIds] = useState(() => (cameBack ? readSavedScope(id) : [id]));
  const scopeKey = scopeIds.join(',');
  const scopeNow = useRef(scopeIds);
  scopeNow.current = scopeIds;
  // The place restored on arrival (kept for a scope trimmed after it).
  const restoredPlace = useRef(null);
  const restoring = useRef(null);
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
      .then(d => {
        const list = d.cellars || [];
        setAllCellars(list);
        // A remembered scope may name a cellar since deleted or unshared —
        // judged only on a real answer (an error must not wipe the scope).
        // Trimmed while its place was being restored: restore it again.
        if (Array.isArray(d.cellars)) {
          const kept = keepKnownCellars(scopeNow.current, id, list);
          if (kept !== scopeNow.current) {
            if (restoredPlace.current) restoring.current = { ...restoredPlace.current, scopeKey: kept.join(',') };
            setScopeIds(kept);
          }
        }
        // Mount-time value: this effect runs once, on arrival.
        if (pendingOwnedScope) {
          // This cellar first, then the rest the user owns — the same set the
          // Statistics page counts, so the chart number and the list agree.
          const owned = list.filter(c => c.userRole === 'owner').map(c => String(c._id));
          setScopeIds([id, ...owned.filter(cid => cid !== id)]);
          setPendingOwnedScope(false);
          // The cross-cellar response carries no `cellar`; the header, edit
          // rights and add-bottle button still need this one's details.
          getCellar(apiFetch, id, 'limit=1')
            .then(r => (r.ok ? r.json() : null))
            .then(data => { if (data?.cellar) setCellar(prev => prev || data.cellar); })
            .catch(() => {});
        }
      })
      .catch(() => setPendingOwnedScope(false));
  }, [apiFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset scope to just this cellar when navigating to another cellar.
  const scopeResetFirstRun = useRef(true);
  useEffect(() => {
    // Skip the mount run: the initial state already is [id], and resetting
    // here would race the ?scope=owned widening above.
    if (scopeResetFirstRun.current) { scopeResetFirstRun.current = false; return; }
    setScopeIds(cameBack ? readSavedScope(id) : [id]);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the scope per cellar, like the filters.
  useEffect(() => {
    try { sessionStorage.setItem(SCOPE_STORAGE_PREFIX + id, JSON.stringify(scopeIds)); } catch { /* best-effort */ }
  }, [id, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // And for "stored in" — racks belong to one cellar (audit 2026-09-07).
  useEffect(() => {
    if (multiScope) setFilters(prev => (prev.storage ? { ...prev, storage: '' } : prev));
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
    if (URL_FILTER_KEYS.some(k => searchParams.has(k)) || searchParams.has('tab') || searchParams.has('scope')) {
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

  // Picking a sort also remembers it on the account, so the next visit to
  // any cellar opens in that order. Only a
  // pick here counts: a deep link's sort is not the user's choice.
  const changeSort = (sort) => {
    setFilters(prev => ({ ...prev, sort }));
    if (CELLAR_SORTS.includes(sort) && sort !== user?.preferences?.cellarSort) {
      updatePreferences({ cellarSort: sort });
    }
  };

  // Serialize array filters for dependency comparison
  const filterKey = [
    debouncedSearch,
    filters.type.join(','), filters.country.join(','), filters.region.join(','),
    filters.appellation.join(','), filters.grapes.join(','), filters.vintage.join(','),
    filters.minRating, filters.maxRating, toMaturityArray(filters.maturity).join(','),
    filters.unplaced, filters.reserved, filters.storage,
    filters.producer, filters.bottleSize, filters.purchaseYear, filters.ratingBand, filters.sort
  ].join('|');

  // Refetch on cellar id, filters, or scope change. `id` is included so an
  // in-place navigation to another cellar whose scope key happens to match the
  // current one still refetches; the fetch-seq guard drops the transient
  // stale-scope response that the id→scope-reset produces.
  // Where this list was left (read once, on arrival): restored when the
  // filters and scope are the same as then — i.e. this is coming back.
  const placeToRestore = useRef(cameBack ? readStored(PLACE_STORAGE_PREFIX + id) : null);
  // The place being restored (restoring, until its list is on screen): a
  // remembered scope trimmed meanwhile (a cellar since gone) asks again with
  // the same count.
  const pendingScroll = useRef(null);
  useEffect(() => {
    if (pendingOwnedScope) return;
    const place = placeToRestore.current;
    placeToRestore.current = null;
    if (place && place.filterKey === filterKey && place.scopeKey === scopeKey
      && Date.now() - (place.at || 0) < PLACE_TTL_MS) {
      restoring.current = place;
      restoredPlace.current = place;
    }
    const restore = restoring.current && restoring.current.filterKey === filterKey ? restoring.current : null;
    restoring.current = restore;
    if (restore) {
      pendingScroll.current = restore.scrollY || 0;
      fetchCellarData(0, Math.min(Math.max(restore.count || 0, BOTTLES_PER_PAGE), MAX_RESTORE));
    } else {
      pendingScroll.current = null;
      fetchCellarData(0);
    }
  }, [id, filterKey, scopeKey, pendingOwnedScope]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll back once the restored page is on screen — or forget it, when the
  // list came back empty, so a later filter does not jump down the page.
  useEffect(() => {
    if (pendingScroll.current == null || loading) return;
    const y = pendingScroll.current;
    pendingScroll.current = null;
    restoring.current = null;
    if (bottles.length > 0) requestAnimationFrame(() => window.scrollTo(0, y));
  }, [bottles, loading]);

  // Save the place when leaving (Back, a bottle, another page). The scroll
  // position is tracked as it changes: by the time a leaving page cleans up,
  // the next one may already have moved the window.
  // Kept after each commit (not during render), so leaving for another
  // cellar saves the one being left, not the one arriving.
  const placeNow = useRef({});
  useEffect(() => {
    placeNow.current = { count: bottles.length, filterKey, scopeKey };
  });
  useEffect(() => {
    let scrollY = window.scrollY;
    const onScroll = () => { scrollY = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      try {
        sessionStorage.setItem(PLACE_STORAGE_PREFIX + id, JSON.stringify({ ...placeNow.current, scrollY, at: Date.now() }));
      } catch { /* best-effort */ }
    };
  }, [id]);

  useEffect(() => {
    fetchStatistics();
    fetchRacks();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps


  const fetchCellarData = async (skip, limit = BOTTLES_PER_PAGE) => {
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
        } else if (key === 'storage') {
          // Mapped to ?rack= / ?rackGroup= below — single-cellar only.
        } else if (Array.isArray(val)) {
          if (val.length > 0) params.append(key, val.join(','));
        } else if (val) {
          params.append(key, val);
        }
      });
      params.set('limit', limit);
      params.set('skip', skip);
      const multi = !(scopeIds.length === 1 && scopeIds[0] === id);
      let res;
      if (multi) {
        params.set('cellars', scopeIds.join(','));
        // Identical bottles collapse per cellar, like the single-cellar view.
        params.set('group', '1');
        res = await getMultiCellarBottles(apiFetch, params.toString());
      } else {
        params.set('group', '1');
        if (filters.unplaced) params.set('excludePlaced', '1');
        if (filters.reserved) params.set('reserved', '1');
        if (filters.storage) {
          const m = /^(group|rack):(.+)$/.exec(String(filters.storage));
          if (m && m[1] === 'rack') params.set('rack', m[2]);
          if (m && m[1] === 'group') params.set('rackGroup', m[2]);
        }
        res = await getCellar(apiFetch, id, params);
      }
      const data = await res.json();
      // A newer fetch started while this one was in flight — drop this response
      // so it can't overwrite newer data or append a wrong-shaped page.
      if (seq !== fetchSeq.current) return;
      if (res.ok) {
        if (data.cellar) setCellar(data.cellar);
        // Single-cellar responses only; the cross-cellar view has no on-order
        // link. Reset when absent (an offline copy carries none), so another
        // cellar's count never lingers.
        if (!multi) setOnOrder(data.onOrder || null);
        setBottlesTotal(data.bottles.total);
        setBottleCount(data.bottles.bottleTotal ?? data.bottles.total);
        if (skip === 0) {
          // Set the data + its shape together so BottlesList never sees a
          // shape/flag mismatch (grouped items rendered as flat, or vice-versa).
          setBottles(data.bottles.items);
          setDataIsMulti(multi);
          // An answer without the list (an offline copy) shows no strip.
          setOpenBottles(Array.isArray(data.openBottles) ? data.openBottles : []);
          // Update facets on every fetch so cascading filters work. An
          // answer with none (a rack / storage filter: the search cannot
          // count it) clears them — never the previous request's numbers.
          setFacets(data.facets ?? null);
          if (data.baseFacets) setBaseFacets(data.baseFacets);
          if (data.facetMeta) setFacetMeta(data.facetMeta);
        } else {
          setBottles(prev => [...prev, ...data.bottles.items]);
        }
      } else {
        setError(data.error || 'Failed to load cellar');
        setErrorRetryable(res.status >= 500);
      }
    } catch {
      // Network failure, or a proxy's HTML error page during a deploy.
      if (seq === fetchSeq.current) {
        setError(t('common.couldNotLoad', 'This could not be loaded. Check your connection and try again.'));
        setErrorRetryable(true);
      }
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setBottlesLoading(false);
      }
    }
  };

  const loadMore = () => fetchCellarData(bottles.length);

  // The maturity buttons' counts, fresh each time the filter opens on this
  // cellar alone (the all-cellars view has none): any change — a bottle
  // drunk, a drink window edited — may have moved bottles between stages.
  // The last counts for this cellar show meanwhile; another cellar's never.
  useEffect(() => {
    if (!showFilterModal || multiScope) return undefined;
    let live = true;
    getCellarMaturityCounts(apiFetch, id)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (live && data?.maturity) setMaturity({ id, counts: data.maturity }); })
      .catch(() => {});
    return () => { live = false; };
  }, [showFilterModal, multiScope, id]); // eslint-disable-line react-hooks/exhaustive-deps

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
        getRacks(apiFetch, id, { summary: true }),
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
        // The "Stored in" filter's choices: every rack with its group label.
        const storageList = (racksData.racks || []).map(r => ({ id: String(r._id), name: r.name, group: r.group || null }));
        setStorageRacks(storageList);
        // A remembered "stored in" whose rack was deleted or group renamed
        // would show an opaque chip over an empty list (audit 2026-09-07).
        setFilters(prev => {
          const m = /^(group|rack):(.+)$/.exec(String(prev.storage || ''));
          if (!m) return prev;
          const alive = m[1] === 'rack'
            ? storageList.some(r => r.id === m[2])
            : storageList.some(r => r.group === m[2]);
          return alive ? prev : { ...prev, storage: '' };
        });
      }
    } catch {}
  };

  const canEdit = cellar?.userRole === 'owner' || cellar?.userRole === 'editor';

  // Only replace the whole page when we have nothing to show yet; once the
  // cellar is loaded, transient fetch failures render as an inline banner.
  // Load again after a failure. `loading` first, or the moment between the
  // tap and the answer shows "No bottles in this cellar yet" again.
  const retryCellar = () => {
    setError(null);
    setLoading(true);
    fetchCellarData(0);
  };
  const retryProps = errorRetryable ? { onRetry: retryCellar } : {};
  // An empty list with a load error says so in the list's own place (below);
  // the banner at the top is for failures over a list that is on screen.
  const errorInList = !!error && bottles.length === 0;

  if (error && !cellar) return <LoadError message={error} {...retryProps} />;

  return (
    <div className="cellar-detail-page">
      {error && !errorInList && (
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
      {bottleNotice && (
        <BottleUndoNotice
          key={`${bottleNotice.bottleId}:${bottleNotice.at || ''}`}
          floating={!!bottleNotice.floating}
          notice={bottleNotice}
          cellarId={id}
          onUndone={() => { fetchCellarData(0); fetchStatistics(); fetchRacks(); }}
          onDismiss={() => setBottleNotice(null)}
        />
      )}
      {addedNotice && (
        <BottleAddedNotice
          notice={addedNotice}
          cellarId={id}
          onDismiss={() => setAddedNotice(null)}
        />
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
              <Link to={`/cellars/${id}/add-bottle`} state={{ cameFrom: `/cellars/${id}` }} className="btn btn-primary btn-small cph-desktop-only">
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
                    {canEdit && (
                      <button
                        className="more-menu-item"
                        onClick={() => { setShowTrash(true); setMoreOpen(false); }}
                      >
                        <span aria-hidden="true">♻️</span> {t('trash.menuItem')}
                      </button>
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
          <OpenNowStrip bottles={openBottles} />
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
            // One chip for the rating range (either bound or both), in the user's scale.
            const ratingLabel = ratingRangeLabel(t, filters.minRating, filters.maxRating, ratingScale);
            if (ratingLabel) activeChips.push({ key: 'rating', value: '', label: ratingLabel });
            if (filters.ratingBand) activeChips.push({ key: 'ratingBand', value: filters.ratingBand, label: t('bottles.chipRatingRange', 'Rating: {{value}}', { value: ratingBandName(filters.ratingBand, t) }) });
            toMaturityArray(filters.maturity).forEach(v => activeChips.push({ key: 'maturity', value: v, label: t(MATURITY_I18N_KEY[v] || v, v) }));
            if (filters.unplaced) activeChips.push({ key: 'unplaced', value: '1', label: t('cellarDetail.unplacedOnly', 'Unplaced only') });
            if (filters.reserved) activeChips.push({ key: 'reserved', value: '1', label: t('cellarDetail.reservedOnly', 'Reserved only') });
            if (filters.producer) activeChips.push({ key: 'producer', value: filters.producer, label: t('bottles.chipProducer', 'Producer: {{value}}', { value: filters.producer }) });
            if (filters.bottleSize) activeChips.push({ key: 'bottleSize', value: filters.bottleSize, label: t('bottles.chipSize', 'Size: {{value}}', { value: filters.bottleSize }) });
            if (filters.purchaseYear) activeChips.push({ key: 'purchaseYear', value: filters.purchaseYear, label: t('bottles.chipPurchased', 'Purchased: {{value}}', { value: filters.purchaseYear }) });
            if (filters.storage) {
              const m = /^(group|rack):(.+)$/.exec(String(filters.storage));
              const rackRow = m && m[1] === 'rack' ? storageRacks.find(r => r.id === m[2]) : null;
              activeChips.push({ key: 'storage', value: filters.storage, label: m ? (m[1] === 'group' ? m[2] : (rackRow ? rackRow.name : m[2])) : filters.storage });
            }

            const removeChip = (chip) => {
              setFilters(prev => {
                // The rating chip stands for a range — both bounds go together.
                if (chip.key === 'rating') return { ...prev, minRating: '', maxRating: '' };
                const val = chip.key === 'maturity' ? toMaturityArray(prev.maturity) : prev[chip.key];
                if (Array.isArray(val)) {
                  return { ...prev, [chip.key]: val.filter(v => v !== chip.value) };
                }
                return { ...prev, [chip.key]: '' };
              });
            };

            const clearAll = () => setFilters(prev => ({
              ...prev,
              type: [], country: [], region: [], appellation: [], grapes: [], vintage: [],
              minRating: '', maxRating: '', maturity: [], unplaced: '', reserved: '', storage: '',
              producer: '', bottleSize: '', purchaseYear: '', ratingBand: ''
            }));

            return (
              <>
                <div className="search-row">
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
                    onChange={e => changeSort(e.target.value)}
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
                    <option value="-quantity">{t('cellarDetail.sortQuantityMost', 'Most bottles first')}</option>
                    <option value="quantity">{t('cellarDetail.sortQuantityFewest', 'Fewest bottles first')}</option>
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

                {/* Bottles bought for this cellar that have not arrived yet —
                    kept out of the list below, one tap away. */}
                {!dataIsMulti && onOrder?.count > 0 && (
                  <Link to={`/cellars/${id}/on-order`} className="on-order-link-bar">
                    <span aria-hidden="true">🚚</span>
                    <span className="on-order-link-text">
                      {t('onOrder.linkCount', { count: onOrder.count })}
                      {onOrder.nextExpected && (
                        <span className={`on-order-link-next${isArrivalLate(onOrder.nextExpected) ? ' is-late' : ''}`}>
                          {' · '}{t(isArrivalLate(onOrder.nextExpected) ? 'onOrder.linkLate' : 'onOrder.linkNext',
                            { month: formatArrivalMonth(onOrder.nextExpected, i18n.language) })}
                        </span>
                      )}
                    </span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
                  </Link>
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
                      bottlesTotal={bottleCount}
                      showUnplaced={!multiScope && hasRacks === true}
                      showReserved={!multiScope}
                      storage={!multiScope ? storageRacks : null}
                      ratingScale={ratingScale}
                      maturityCounts={!multiScope && maturity?.id === id ? maturity.counts : null}
                    />
                  </Suspense>
                )}
              </>
            );
          })()}

          {loading ? (
            <div className="loading">{t('cellarDetail.loadingCellar')}</div>
          ) : error && bottles.length === 0 ? (
            // A failed load is not an empty cellar — "No bottles in this
            // cellar yet" here reads as "my bottles are gone".
            <LoadError message={error} {...retryProps} />
          ) : bottles.length === 0 && !bottlesLoading ? (
            (filters.search || filters.vintage?.length || filters.minRating || filters.maxRating || toMaturityArray(filters.maturity).length || filters.unplaced || filters.reserved || filters.storage || filters.producer || filters.bottleSize || filters.purchaseYear || filters.ratingBand || filters.type?.length || filters.country?.length || filters.region?.length || filters.appellation?.length || filters.grapes?.length) ? (
              <div className="empty-state">
                <p>{t('cellarDetail.noSearchResults')}</p>
                {filters.search && !multiScope && (
                  <p>
                    <Link to={`/bottles?${new URLSearchParams({ status: 'all', search: filters.search })}`}>
                      {t('cellarDetail.searchAllCellars', { query: filters.search, defaultValue: 'Search all cellars for "{{query}}"' })}
                    </Link>
                  </p>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <p>{t('cellarDetail.noBottles')}</p>
                {canEdit && (
                  <Link to={`/cellars/${id}/add-bottle`} state={{ cameFrom: `/cellars/${id}` }} className="btn btn-primary">
                    {t('cellarDetail.addFirstBottle')}
                  </Link>
                )}
                {/* Import is how big collections arrive (and who loads one
                    stays), but it lived only in the ⋯ menu — say it here,
                    where someone with a collection elsewhere actually is. */}
                {canEdit && (
                  <p className="empty-state-import">
                    <Link to={`/cellars/${id}/import`}>
                      {t('cellarDetail.importInstead', 'Or import your collection from CellarTracker, Vivino or a spreadsheet')}
                    </Link>
                  </p>
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
              canConsume={!dataIsMulti && canEdit}
              onBulkDone={() => { fetchCellarData(0); fetchStatistics(); fetchRacks(); }}
              onSelectModeChange={setSelecting}
              onTakenOut={setBottleNotice}
              placesKnown={!dataIsMulti && hasRacks !== null}
            />
          )}
        </div>
      )}

      {/* ── FAB: Add Bottle (mobile only) — hidden while selecting bottles ── */}
      {!loading && canEdit && !selecting && (
        <Link
          to={`/cellars/${id}/add-bottle`} state={{ cameFrom: `/cellars/${id}` }}
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

        {showTrash && (
          <RecentlyDeletedModal
            cellarId={id}
            onClose={(restoredAny) => {
              setShowTrash(false);
              if (restoredAny) { fetchCellarData(0); fetchStatistics(); fetchRacks(); }
            }}
          />
        )}
      </Suspense>
    </div>
  );
}

export default CellarDetail;
