import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import {
  adminGetWineRequests, adminResolveWineRequest, adminRejectWineRequest,
  adminGetCountries, adminGetGrapes, adminGetRegions, adminGetAppellations,
} from '../api/admin';
import { searchWines, getAiWineInfo } from '../api/wines';
import { WINE_TYPES } from '../config/wineTypes';
import GrapePicker from '../components/GrapePicker';
import './AdminRequests.css';

function AdminRequests() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  // Pagination — the backend caps this list at 50 per request, so without
  // page/limit params anything beyond the oldest 50 was unreachable forever.
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [resolveData, setResolveData] = useState({
    mode: 'create', // 'create' or 'link'
    adminNotes: '',
    wineDefinitionId: '',
    wineData: { name: '', producer: '', country: '', region: '', type: 'red', appellation: '', grapes: [], image: '' }
  });
  const [duplicates, setDuplicates] = useState([]);
  const [countries, setCountries] = useState([]);
  const [regions, setRegions] = useState([]);
  const [appellations, setAppellations] = useState([]);
  const [grapes, setGrapes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [serverDupes, setServerDupes] = useState(null);
  const [linkSearch, setLinkSearch] = useState('');
  const [linkResults, setLinkResults] = useState([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [aiLookup, setAiLookup] = useState({ loading: false, error: null });

  // Tracks the currently selected request id so slow async chains
  // (AI lookup, duplicate check) can detect the selection changed
  // mid-flight and discard their results instead of overwriting the
  // newly selected request's form.
  const selectedIdRef = useRef(null);
  useEffect(() => {
    selectedIdRef.current = selected?._id ?? null;
  }, [selected]);

  // Debounce timer + monotonic request id for the duplicate check, so
  // per-keystroke requests are coalesced and stale responses discarded.
  const dupTimerRef = useRef(null);
  const dupReqIdRef = useRef(0);
  useEffect(() => () => clearTimeout(dupTimerRef.current), []);

  useEffect(() => {
    fetchRequests();
  }, [statusFilter, page, apiFetch]);

  useEffect(() => {
    fetchCountries();
    fetchGrapes();
  }, [apiFetch]);

  useEffect(() => {
    if (resolveData.mode !== 'link' || linkSearch.length < 2) {
      setLinkResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setLinkSearching(true);
      try {
        const res = await searchWines(apiFetch, `search=${encodeURIComponent(linkSearch)}&limit=8`);
        const data = await res.json();
        if (res.ok) setLinkResults(data.wines || []);
      } catch (err) {
        console.error('Wine search failed:', err);
      } finally {
        setLinkSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [linkSearch, resolveData.mode, apiFetch]);

  const REQUESTS_PER_PAGE = 50;

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: REQUESTS_PER_PAGE });
      if (statusFilter) params.set('status', statusFilter);
      const res = await adminGetWineRequests(apiFetch, `?${params}`);
      const data = await res.json();
      if (res.ok) {
        setRequests(data.requests || []);
        setTotal(data.total || 0);
        // Resolving/rejecting can shrink the filtered set — if the current
        // page fell off the end, snap back to the new last page (refetches).
        const pages = Math.max(1, Math.ceil((data.total || 0) / REQUESTS_PER_PAGE));
        if (page > pages) setPage(pages);
      }
    } catch (err) {
      console.error('Failed to fetch requests:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCountries = async () => {
    try {
      const res = await adminGetCountries(apiFetch);
      const data = await res.json();
      if (res.ok) setCountries(data.countries);
    } catch (err) {
      console.error('Failed to fetch countries:', err);
    }
  };

  const fetchRegions = async (countryId) => {
    if (!countryId) { setRegions([]); setAppellations([]); return; }
    try {
      const res = await adminGetRegions(apiFetch, countryId);
      const data = await res.json();
      if (res.ok) setRegions(data.regions);
    } catch (err) {
      console.error('Failed to fetch regions:', err);
    }
  };

  const fetchAppellations = async (countryId, regionId) => {
    if (!countryId) { setAppellations([]); return; }
    try {
      const params = new URLSearchParams({ country: countryId });
      if (regionId) params.set('region', regionId);
      const res = await adminGetAppellations(apiFetch, params);
      const data = await res.json();
      if (res.ok) setAppellations(data.appellations || []);
    } catch (err) {
      console.error('Failed to fetch appellations:', err);
    }
  };

  const fetchGrapes = async () => {
    try {
      const res = await adminGetGrapes(apiFetch);
      const data = await res.json();
      if (res.ok) setGrapes(data.grapes);
    } catch (err) {
      console.error('Failed to fetch grapes:', err);
    }
  };

  const checkDuplicates = (name, producer) => {
    clearTimeout(dupTimerRef.current);
    if (!name || !producer) return;
    dupTimerRef.current = setTimeout(async () => {
      const reqId = ++dupReqIdRef.current;
      try {
        const res = await apiFetch(
          `/api/admin/wines/duplicates?name=${encodeURIComponent(name)}&producer=${encodeURIComponent(producer)}&threshold=0.75`
        );
        const data = await res.json();
        if (reqId !== dupReqIdRef.current) return; // stale — a newer check superseded this one
        if (res.ok) setDuplicates(data.candidates);
      } catch (err) {
        console.error('Duplicate check failed:', err);
      }
    }, 350);
  };

  const handleSelectRequest = (request) => {
    setSelected(request);
    setRegions([]);
    setResolveData({
      mode: request.requestType === 'grape_suggestion' ? 'apply_grapes' : 'create',
      adminNotes: '',
      wineDefinitionId: '',
      applyGrapes: [],
      wineData: {
        name: request.wineName,
        producer: request.producer || '',
        country: '',
        region: '',
        type: 'red',
        appellation: '',
        grapes: [],
        image: (request.image && !request.image.startsWith('data:')) ? request.image : ''
      }
    });
    // Cancel any pending/in-flight duplicate check from the previous request
    clearTimeout(dupTimerRef.current);
    dupReqIdRef.current += 1;
    setDuplicates([]);
    setError(null);
    setServerDupes(null);
    setLinkSearch('');
    setLinkResults([]);
    setAiLookup({ loading: false, error: null });
  };

  const handleAiLookup = async () => {
    // Capture the request this lookup was started for — if the admin selects
    // a different request while the AI chain is in flight, bail silently
    // instead of overwriting the new request's form with the old data.
    const requestId = selected._id;
    const stale = () => selectedIdRef.current !== requestId;
    const query = [selected.wineName, selected.producer].filter(Boolean).join(' ');
    setAiLookup({ loading: true, error: null });
    try {
      const res = await getAiWineInfo(apiFetch, query);
      const data = await res.json();
      if (stale()) return;
      if (!res.ok || !data.wine) {
        setAiLookup({ loading: false, error: 'Could not identify this wine' });
        return;
      }
      const wine = data.wine;
      const newWineData = {
        ...resolveData.wineData,
        type: wine.type || resolveData.wineData.type,
        appellation: wine.appellation || '',
        region: '',
      };

      const country = countries.find(c => c.name.toLowerCase() === wine.country?.toLowerCase());
      if (country) {
        newWineData.country = country._id;
        const regRes = await adminGetRegions(apiFetch, country._id);
        const regData = await regRes.json();
        if (stale()) return;
        if (regRes.ok) {
          setRegions(regData.regions);
          const region = regData.regions.find(r => r.name.toLowerCase() === wine.region?.toLowerCase());
          if (region) newWineData.region = region._id;
          const appParams = new URLSearchParams({ country: country._id });
          if (region) appParams.set('region', region._id);
          const appRes = await adminGetAppellations(apiFetch, appParams);
          const appData = await appRes.json();
          if (stale()) return;
          if (appRes.ok) setAppellations(appData.appellations || []);
        }
      }

      if (wine.grapes?.length > 0) {
        newWineData.grapes = wine.grapes
          .map(gName => grapes.find(g => g.name.toLowerCase() === gName.toLowerCase()))
          .filter(Boolean)
          .map(g => g._id);
      }

      setResolveData(prev => ({ ...prev, mode: 'create', wineData: newWineData }));
      checkDuplicates(newWineData.name, newWineData.producer);
      setAiLookup({ loading: false, error: null });
    } catch {
      if (stale()) return;
      setAiLookup({ loading: false, error: 'Network error during lookup' });
    }
  };

  const handleResolve = async (confirmCreate = false) => {
    setSubmitting(true);
    setError(null);
    setServerDupes(null);
    try {
      const body = { adminNotes: resolveData.adminNotes };
      if (resolveData.mode === 'apply_grapes') {
        body.applyGrapes = resolveData.applyGrapes || [];
      } else if (resolveData.mode === 'create') {
        body.createNew = true;
        body.wineData = resolveData.wineData;
        // Only after the admin explicitly chose "create anyway" — skips the
        // server-side duplicate probe.
        if (confirmCreate) body.confirmCreate = true;
      } else {
        body.wineDefinitionId = resolveData.wineDefinitionId;
      }

      const res = await adminResolveWineRequest(apiFetch, selected._id, body);

      const data = await res.json();
      if (res.ok) {
        setSelected(null);
        fetchRequests();
      } else if (res.status === 409 && data.candidates?.length) {
        // Server-side dedup probe found near-identical registry wine(s) —
        // surface them so the admin links the request instead of creating.
        setServerDupes(data.candidates);
        setError(data.error || 'Very similar registry wines already exist');
      } else {
        setError(data.error || 'Failed to resolve request');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    const notes = resolveData.adminNotes;
    if (!notes.trim()) {
      setError('Admin notes are required when rejecting');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminRejectWineRequest(apiFetch, selected._id, { adminNotes: notes });

      const data = await res.json();
      if (res.ok) {
        setSelected(null);
        fetchRequests();
      } else {
        setError(data.error || 'Failed to reject request');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / REQUESTS_PER_PAGE));

  return (
    <div className="admin-requests-page">
      <div className="page-header">
        <h1>{t('admin.requests.title')}</h1>
      </div>

      <div className="admin-layout">
        {/* Left panel: request list */}
        <div className="requests-panel">
          <div className="panel-filters">
            {/* 'withdrawn' = requests that left the queue with their deleted
                cellar — excluded from every other view (including All, which
                the backend now defaults to non-withdrawn), reachable here. */}
            {['pending', 'resolved', 'rejected', 'withdrawn', ''].map(s => (
              <button
                key={s || 'all'}
                className={`filter-btn ${statusFilter === s ? 'active' : ''}`}
                onClick={() => { setStatusFilter(s); setPage(1); }}
              >
                {s || t('admin.requests.statusAll')}
              </button>
            ))}
          </div>

          {!loading && (
            <div className="requests-total">
              {t('admin.requests.totalCount', { count: total })}
            </div>
          )}

          {loading ? (
            <div className="loading">{t('common.loading')}</div>
          ) : requests.length === 0 ? (
            <div className="empty-state"><p>{t('admin.requests.noRequests')}</p></div>
          ) : (
            <div className="requests-list">
              {requests.map(req => (
                <div
                  key={req._id}
                  className={`request-item ${selected?._id === req._id ? 'active' : ''}`}
                  onClick={() => handleSelectRequest(req)}
                >
                  <div className="request-item-header">
                    <strong>{req.wineName}</strong>
                    <span className={`status-badge status-${req.status}`}>{req.status}</span>
                  </div>
                  {req.producer && (
                    <div className="request-item-producer">{req.producer}</div>
                  )}
                  <div className="request-item-meta">
                    <span>By: {req.user?.username}</span>
                    <span>{new Date(req.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && totalPages > 1 && (
            <div className="requests-pagination">
              <button
                className="btn btn-secondary btn-small"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                {t('common.previous')}
              </button>
              <span className="requests-pagination-page">
                {t('admin.audit.page', { current: page, total: totalPages })}
              </span>
              <button
                className="btn btn-secondary btn-small"
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                {t('common.next')}
              </button>
            </div>
          )}
        </div>

        {/* Right panel: action area */}
        <div className="action-panel">
          {!selected ? (
            <div className="empty-state"><p>{t('admin.requests.selectRequest')}</p></div>
          ) : (
            <div>
              <div className="request-detail card">
                <h2>
                  {selected.wineName}
                  {selected.requestType === 'grape_suggestion' && (
                    <span className="request-type-badge" style={{ marginLeft: '0.6rem', fontSize: '0.7rem' }}>
                      {t('admin.requests.typeGrapeSuggestion', 'Grape suggestion')}
                    </span>
                  )}
                </h2>
                {selected.producer && (
                  <p><strong>Producer:</strong> {selected.producer}</p>
                )}
                <p><strong>{t('admin.requests.requestedBy')}</strong> {selected.user?.username} ({selected.user?.email})</p>
                <p><strong>{t('admin.requests.date')}</strong> {new Date(selected.createdAt).toLocaleDateString()}</p>
                {selected.requestType === 'grape_suggestion' ? (
                  selected.suggestedGrapes?.length > 0 && (
                    <p>
                      <strong>{t('admin.requests.suggestedGrapes', 'Suggested varieties')}: </strong>
                      {selected.suggestedGrapes.join(', ')}
                    </p>
                  )
                ) : (
                  <p>
                    <strong>{t('common.source')}:</strong>{' '}
                    <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer">
                      {selected.sourceUrl}
                    </a>
                  </p>
                )}
                {selected.image && (
                  <img src={selected.image} alt="Wine" className="wine-image-preview" />
                )}
                {selected.requestType !== 'grape_suggestion' && selected.status === 'pending' && (
                  <div className="ai-lookup-row">
                    <button
                      className="btn btn-secondary btn-small ai-lookup-btn"
                      onClick={handleAiLookup}
                      disabled={aiLookup.loading}
                    >
                      {aiLookup.loading ? (
                        <>
                          <span className="ai-lookup-spinner" />
                          Looking up…
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 2L9 9L2 12L9 15L12 22L15 15L22 12L15 9Z" />
                          </svg>
                          Look up
                        </>
                      )}
                    </button>
                    {aiLookup.error && <span className="ai-lookup-error">{aiLookup.error}</span>}
                  </div>
                )}
              </div>

              {selected.status === 'pending' && (
                <div className="resolve-panel card">
                  {error && <div className="alert alert-error">{error}</div>}
                  {serverDupes?.length > 0 && resolveData.mode === 'create' && (
                    <div className="alert alert-info">
                      <strong>{t('admin.requests.dupTitle', 'Possible duplicates found')}</strong>
                      <ul style={{ margin: '8px 0 8px 18px' }}>
                        {serverDupes.map((c) => (
                          <li key={c._id}>
                            “{c.name}” — {c.producer}{c.appellation ? ` (${c.appellation})` : ''}
                          </li>
                        ))}
                      </ul>
                      <div>{t('admin.requests.dupHint', 'Link the request to one of these instead — or create anyway if it is genuinely different.')}</div>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ marginTop: 8 }}
                        disabled={submitting}
                        onClick={() => handleResolve(true)}
                      >
                        {t('admin.requests.dupCreateAnyway', 'Create anyway')}
                      </button>
                    </div>
                  )}

                  {selected.requestType === 'grape_suggestion' ? (
                    // ── Grape suggestion: pick grapes to apply ──
                    <div>
                      <p className="grape-suggestion-note">
                        {t('admin.requests.applyGrapesNote', 'Select the grape varieties to add to this wine. Unrecognised names can be added to the taxonomy first.')}
                      </p>
                      {grapes.length > 0 && (
                        <div className="form-group">
                          <label>
                            {t('admin.requests.applyGrapesLabel', 'Grapes to add')}
                            {resolveData.applyGrapes?.length > 0 && (
                              <span className="grape-count"> ({resolveData.applyGrapes.length} selected)</span>
                            )}
                          </label>
                          <GrapePicker
                            grapes={grapes}
                            selected={resolveData.applyGrapes || []}
                            onChange={(ids) => setResolveData({ ...resolveData, applyGrapes: ids })}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                  <div className="mode-tabs">
                    <button
                      className={`tab-btn ${resolveData.mode === 'create' ? 'active' : ''}`}
                      onClick={() => setResolveData({ ...resolveData, mode: 'create' })}
                    >
                      {t('admin.requests.createNewWine')}
                    </button>
                    <button
                      className={`tab-btn ${resolveData.mode === 'link' ? 'active' : ''}`}
                      onClick={() => setResolveData({ ...resolveData, mode: 'link' })}
                    >
                      {t('admin.requests.linkExistingWine')}
                    </button>
                  </div>
                  )}

                  {resolveData.mode === 'create' && (
                    <div>
                      <div className="grid-2">
                        <div className="form-group">
                          <label>{t('admin.requests.wineNameLabel')}</label>
                          <input
                            type="text"
                            value={resolveData.wineData.name}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, name: e.target.value };
                              setResolveData({ ...resolveData, wineData });
                              checkDuplicates(e.target.value, resolveData.wineData.producer);
                            }}
                          />
                        </div>
                        <div className="form-group">
                          <label>{t('admin.requests.producerLabel')}</label>
                          <input
                            type="text"
                            value={resolveData.wineData.producer}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, producer: e.target.value };
                              setResolveData({ ...resolveData, wineData });
                              checkDuplicates(resolveData.wineData.name, e.target.value);
                            }}
                          />
                        </div>
                        <div className="form-group">
                          <label>{t('admin.requests.countryLabel')}</label>
                          <select
                            value={resolveData.wineData.country}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, country: e.target.value, region: '', appellation: '' };
                              setResolveData({ ...resolveData, wineData });
                              fetchRegions(e.target.value);
                              fetchAppellations(e.target.value, '');
                            }}
                          >
                            <option value="">{t('admin.requests.selectCountry')}</option>
                            {countries.map(c => (
                              <option key={c._id} value={c._id}>{c.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="form-group">
                          <label>{t('admin.requests.regionLabel')}</label>
                          <select
                            value={resolveData.wineData.region}
                            onChange={(e) => {
                              const regionId = e.target.value;
                              const wineData = { ...resolveData.wineData, region: regionId, appellation: '' };
                              setResolveData({ ...resolveData, wineData });
                              fetchAppellations(resolveData.wineData.country, regionId);
                            }}
                            disabled={!resolveData.wineData.country}
                          >
                            <option value="">{t('admin.requests.selectRegion')}</option>
                            {regions.map(r => (
                              <option key={r._id} value={r._id}>{r.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="form-group">
                          <label>{t('admin.requests.typeLabel')}</label>
                          <select
                            value={resolveData.wineData.type}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, type: e.target.value };
                              setResolveData({ ...resolveData, wineData });
                            }}
                          >
                            {WINE_TYPES.map(type => (
                              <option key={type} value={type}>{type}</option>
                            ))}
                          </select>
                        </div>
                        <div className="form-group">
                          <label>{t('admin.requests.appellationLabel')}</label>
                          <select
                            value={resolveData.wineData.appellation}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, appellation: e.target.value };
                              setResolveData({ ...resolveData, wineData });
                            }}
                            disabled={!resolveData.wineData.country}
                          >
                            <option value="">{t('admin.requests.selectAppellation')}</option>
                            {appellations.map(a => (
                              <option key={a._id} value={a.name}>{a.name}</option>
                            ))}
                          </select>
                        </div>
                        {grapes.length > 0 && (
                          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                            <label>
                              {t('admin.requests.grapesLabel')}
                              {resolveData.wineData.grapes.length > 0 && (
                                <span className="grape-count"> ({resolveData.wineData.grapes.length} selected)</span>
                              )}
                            </label>
                            <GrapePicker
                              grapes={grapes}
                              selected={resolveData.wineData.grapes}
                              onChange={(ids) => {
                                const wineData = { ...resolveData.wineData, grapes: ids };
                                setResolveData({ ...resolveData, wineData });
                              }}
                            />
                          </div>
                        )}
                        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                          <label>{t('admin.requests.imageUrlLabel')}</label>
                          <input
                            type="url"
                            value={resolveData.wineData.image}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, image: e.target.value };
                              setResolveData({ ...resolveData, wineData });
                            }}
                            placeholder="https://..."
                          />
                        </div>
                      </div>

                      {duplicates.length > 0 && (
                        <div className="duplicates-warning">
                          <strong>{t('admin.requests.potentialDuplicates')}</strong>
                          {duplicates.map(d => (
                            <div key={d.wine._id} className="duplicate-item">
                              <span>{d.wine.name} by {d.wine.producer}</span>
                              <span className="similarity">{t('admin.requests.match', { percent: Math.round(d.scores.overall * 100) })}</span>
                              <button
                                className="btn btn-secondary btn-small"
                                onClick={() => {
                                  setResolveData({ ...resolveData, mode: 'link', wineDefinitionId: d.wine._id });
                                  setLinkSearch(`${d.wine.name}${d.wine.producer ? ' — ' + d.wine.producer : ''}`);
                                  setLinkResults([]);
                                }}
                              >
                                {t('admin.requests.useThis')}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {resolveData.mode === 'link' && (
                    <div className="form-group link-search-group">
                      <label>{t('admin.requests.linkSearchLabel', 'Search Wine Registry')}</label>
                      <div className="link-search-wrapper">
                        <input
                          type="text"
                          value={linkSearch}
                          onChange={(e) => {
                            setLinkSearch(e.target.value);
                            setResolveData(prev => ({ ...prev, wineDefinitionId: '' }));
                          }}
                          placeholder={t('admin.requests.linkSearchPlaceholder', 'Search by name or producer…')}
                          autoComplete="off"
                        />
                        {linkSearching && <span className="link-search-spinner">{t('common.loading', 'Loading…')}</span>}
                        {linkResults.length > 0 && (
                          <ul className="link-search-results">
                            {linkResults.map(wine => (
                              <li
                                key={wine._id}
                                className="link-search-result"
                                onMouseDown={() => {
                                  setResolveData(prev => ({ ...prev, wineDefinitionId: wine._id }));
                                  setLinkSearch(`${wine.name}${wine.producer ? ' — ' + wine.producer : ''}`);
                                  setLinkResults([]);
                                }}
                              >
                                <span className="link-result-name">{wine.name}</span>
                                {wine.producer && <span className="link-result-producer">{wine.producer}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      {resolveData.wineDefinitionId && (
                        <div className="link-selected-id">
                          {t('admin.requests.selectedId', 'Selected ID:')} <code>{resolveData.wineDefinitionId}</code>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="form-group">
                    <label>{t('admin.requests.adminNotesLabel')} <span className="admin-notes-hint">{t('admin.requests.adminNotesRequiredHint', '(required when rejecting)')}</span></label>
                    <textarea
                      value={resolveData.adminNotes}
                      onChange={(e) => setResolveData({ ...resolveData, adminNotes: e.target.value })}
                      rows="3"
                      placeholder={t('admin.requests.adminNotesPlaceholder')}
                    />
                  </div>

                  <div className="form-actions">
                    <button
                      onClick={() => handleResolve()}
                      className="btn btn-success"
                      disabled={submitting}
                    >
                      {submitting ? t('admin.requests.processing') : t('admin.requests.resolve')}
                    </button>
                    <button
                      onClick={handleReject}
                      className="btn btn-danger"
                      disabled={submitting}
                    >
                      {t('admin.requests.reject')}
                    </button>
                  </div>
                </div>
              )}

              {selected.status !== 'pending' && (
                <div className="card">
                  <p><strong>{t('admin.requests.statusLabel')}</strong> {selected.status}</p>
                  {selected.adminNotes && <p><strong>{t('admin.requests.notesLabel')}</strong> {selected.adminNotes}</p>}
                  {selected.linkedWineDefinition && (
                    <p><strong>{t('admin.requests.linkedWine')}</strong> {selected.linkedWineDefinition.name}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminRequests;
