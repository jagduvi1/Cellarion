import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import GrapePicker from '../components/GrapePicker';
import './AdminRequests.css';

function AdminRequests() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
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

  useEffect(() => {
    fetchRequests();
  }, [statusFilter, apiFetch]);

  useEffect(() => {
    fetchCountries();
    fetchGrapes();
  }, [apiFetch]);

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const params = statusFilter ? `?status=${statusFilter}` : '';
      const res = await apiFetch(`/api/admin/wine-requests${params}`);
      const data = await res.json();
      if (res.ok) setRequests(data.requests);
    } catch (err) {
      console.error('Failed to fetch requests:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCountries = async () => {
    try {
      const res = await apiFetch('/api/admin/taxonomy/countries');
      const data = await res.json();
      if (res.ok) setCountries(data.countries);
    } catch (err) {
      console.error('Failed to fetch countries:', err);
    }
  };

  const fetchRegions = async (countryId) => {
    if (!countryId) { setRegions([]); setAppellations([]); return; }
    try {
      const res = await apiFetch(`/api/admin/taxonomy/regions?country=${countryId}`);
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
      const res = await apiFetch(`/api/admin/taxonomy/appellations?${params}`);
      const data = await res.json();
      if (res.ok) setAppellations(data.appellations || []);
    } catch (err) {
      console.error('Failed to fetch appellations:', err);
    }
  };

  const fetchGrapes = async () => {
    try {
      const res = await apiFetch('/api/admin/taxonomy/grapes');
      const data = await res.json();
      if (res.ok) setGrapes(data.grapes);
    } catch (err) {
      console.error('Failed to fetch grapes:', err);
    }
  };

  const checkDuplicates = async (name, producer) => {
    if (!name || !producer) return;
    try {
      const res = await apiFetch(
        `/api/admin/wines/duplicates?name=${encodeURIComponent(name)}&producer=${encodeURIComponent(producer)}&threshold=0.75`
      );
      const data = await res.json();
      if (res.ok) setDuplicates(data.candidates);
    } catch (err) {
      console.error('Duplicate check failed:', err);
    }
  };

  const handleSelectRequest = (request) => {
    setSelected(request);
    setRegions([]);
    setResolveData({
      mode: 'create',
      adminNotes: '',
      wineDefinitionId: '',
      wineData: {
        name: request.wineName,
        producer: '',
        country: '',
        region: '',
        type: 'red',
        appellation: '',
        grapes: [],
        image: request.image || ''
      }
    });
    setDuplicates([]);
    setError(null);
  };

  const handleResolve = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body = { adminNotes: resolveData.adminNotes };
      if (resolveData.mode === 'create') {
        body.createNew = true;
        body.wineData = resolveData.wineData;
      } else {
        body.wineDefinitionId = resolveData.wineDefinitionId;
      }

      const res = await apiFetch(`/api/admin/wine-requests/${selected._id}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      if (res.ok) {
        setSelected(null);
        fetchRequests();
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
      const res = await apiFetch(`/api/admin/wine-requests/${selected._id}/reject`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminNotes: notes })
      });

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

  return (
    <div className="admin-requests-page">
      <div className="page-header">
        <h1>{t('admin.requests.title')}</h1>
      </div>

      <div className="admin-layout">
        {/* Left panel: request list */}
        <div className="requests-panel">
          <div className="panel-filters">
            {['pending', 'resolved', 'rejected', ''].map(s => (
              <button
                key={s || 'all'}
                className={`filter-btn ${statusFilter === s ? 'active' : ''}`}
                onClick={() => setStatusFilter(s)}
              >
                {s || t('admin.requests.statusAll')}
              </button>
            ))}
          </div>

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
                  <div className="request-item-meta">
                    <span>By: {req.user?.username}</span>
                    <span>{new Date(req.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
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
                <h2>{selected.wineName}</h2>
                <p><strong>{t('admin.requests.requestedBy')}</strong> {selected.user?.username} ({selected.user?.email})</p>
                <p><strong>{t('admin.requests.date')}</strong> {new Date(selected.createdAt).toLocaleDateString()}</p>
                <p>
                  <strong>{t('common.source')}:</strong>{' '}
                  <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {selected.sourceUrl}
                  </a>
                </p>
                {selected.image && (
                  <img src={selected.image} alt="Wine" className="wine-image-preview" />
                )}
              </div>

              {selected.status === 'pending' && (
                <div className="resolve-panel card">
                  {error && <div className="alert alert-error">{error}</div>}

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
                            {['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'].map(type => (
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
                              <span className="similarity">{Math.round(d.scores.overall * 100)}{t('admin.requests.match')}</span>
                              <button
                                className="btn btn-secondary btn-small"
                                onClick={() => setResolveData({
                                  ...resolveData,
                                  mode: 'link',
                                  wineDefinitionId: d.wine._id
                                })}
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
                    <div className="form-group">
                      <label>{t('admin.requests.wineDefIdLabel')}</label>
                      <input
                        type="text"
                        value={resolveData.wineDefinitionId}
                        onChange={(e) => setResolveData({ ...resolveData, wineDefinitionId: e.target.value })}
                        placeholder={t('admin.requests.wineDefIdPlaceholder')}
                      />
                    </div>
                  )}

                  <div className="form-group">
                    <label>{t('admin.requests.adminNotesLabel')} {resolveData.mode === 'reject' && '*'}</label>
                    <textarea
                      value={resolveData.adminNotes}
                      onChange={(e) => setResolveData({ ...resolveData, adminNotes: e.target.value })}
                      rows="3"
                      placeholder={t('admin.requests.adminNotesPlaceholder')}
                    />
                  </div>

                  <div className="form-actions">
                    <button
                      onClick={handleResolve}
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
