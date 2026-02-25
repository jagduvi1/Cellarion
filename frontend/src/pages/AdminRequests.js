import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './AdminRequests.css';

function AdminRequests() {
  const { token } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [selected, setSelected] = useState(null);
  const [resolveData, setResolveData] = useState({
    mode: 'create', // 'create' or 'link'
    adminNotes: '',
    wineDefinitionId: '',
    wineData: { name: '', producer: '', country: '', type: 'red', appellation: '', image: '' }
  });
  const [duplicates, setDuplicates] = useState([]);
  const [countries, setCountries] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchRequests();
    fetchCountries();
  }, [statusFilter, token]);

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const params = statusFilter ? `?status=${statusFilter}` : '';
      const res = await fetch(`/api/admin/wine-requests${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
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
      const res = await fetch('/api/admin/taxonomy/countries', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) setCountries(data.countries);
    } catch (err) {
      console.error('Failed to fetch countries:', err);
    }
  };

  const checkDuplicates = async (name, producer) => {
    if (!name || !producer) return;
    try {
      const res = await fetch(
        `/api/admin/wines/duplicates?name=${encodeURIComponent(name)}&producer=${encodeURIComponent(producer)}&threshold=0.75`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const data = await res.json();
      if (res.ok) setDuplicates(data.candidates);
    } catch (err) {
      console.error('Duplicate check failed:', err);
    }
  };

  const handleSelectRequest = (request) => {
    setSelected(request);
    setResolveData({
      mode: 'create',
      adminNotes: '',
      wineDefinitionId: '',
      wineData: {
        name: request.wineName,
        producer: '',
        country: '',
        type: 'red',
        appellation: '',
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

      const res = await fetch(`/api/admin/wine-requests/${selected._id}/resolve`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
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
      const res = await fetch(`/api/admin/wine-requests/${selected._id}/reject`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
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
        <h1>Admin: Wine Requests</h1>
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
                {s || 'All'}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="loading">Loading...</div>
          ) : requests.length === 0 ? (
            <div className="empty-state"><p>No requests found</p></div>
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
            <div className="empty-state"><p>Select a request to review</p></div>
          ) : (
            <div>
              <div className="request-detail card">
                <h2>{selected.wineName}</h2>
                <p><strong>Requested by:</strong> {selected.user?.username} ({selected.user?.email})</p>
                <p><strong>Date:</strong> {new Date(selected.createdAt).toLocaleDateString()}</p>
                <p>
                  <strong>Source:</strong>{' '}
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
                      Create New Wine
                    </button>
                    <button
                      className={`tab-btn ${resolveData.mode === 'link' ? 'active' : ''}`}
                      onClick={() => setResolveData({ ...resolveData, mode: 'link' })}
                    >
                      Link Existing Wine
                    </button>
                  </div>

                  {resolveData.mode === 'create' && (
                    <div>
                      <div className="grid-2">
                        <div className="form-group">
                          <label>Wine Name *</label>
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
                          <label>Producer *</label>
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
                          <label>Country *</label>
                          <select
                            value={resolveData.wineData.country}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, country: e.target.value };
                              setResolveData({ ...resolveData, wineData });
                            }}
                          >
                            <option value="">Select country</option>
                            {countries.map(c => (
                              <option key={c._id} value={c._id}>{c.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="form-group">
                          <label>Type</label>
                          <select
                            value={resolveData.wineData.type}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, type: e.target.value };
                              setResolveData({ ...resolveData, wineData });
                            }}
                          >
                            {['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'].map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </div>
                        <div className="form-group">
                          <label>Appellation</label>
                          <input
                            type="text"
                            value={resolveData.wineData.appellation}
                            onChange={(e) => {
                              const wineData = { ...resolveData.wineData, appellation: e.target.value };
                              setResolveData({ ...resolveData, wineData });
                            }}
                          />
                        </div>
                        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                          <label>Image URL</label>
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
                          <strong>⚠️ Potential Duplicates Found</strong>
                          {duplicates.map(d => (
                            <div key={d.wine._id} className="duplicate-item">
                              <span>{d.wine.name} by {d.wine.producer}</span>
                              <span className="similarity">{Math.round(d.scores.overall * 100)}% match</span>
                              <button
                                className="btn btn-secondary btn-small"
                                onClick={() => setResolveData({
                                  ...resolveData,
                                  mode: 'link',
                                  wineDefinitionId: d.wine._id
                                })}
                              >
                                Use This
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {resolveData.mode === 'link' && (
                    <div className="form-group">
                      <label>Wine Definition ID</label>
                      <input
                        type="text"
                        value={resolveData.wineDefinitionId}
                        onChange={(e) => setResolveData({ ...resolveData, wineDefinitionId: e.target.value })}
                        placeholder="Paste wine ID from registry"
                      />
                    </div>
                  )}

                  <div className="form-group">
                    <label>Admin Notes {resolveData.mode === 'reject' && '*'}</label>
                    <textarea
                      value={resolveData.adminNotes}
                      onChange={(e) => setResolveData({ ...resolveData, adminNotes: e.target.value })}
                      rows="3"
                      placeholder="Optional notes for the user..."
                    />
                  </div>

                  <div className="form-actions">
                    <button
                      onClick={handleResolve}
                      className="btn btn-success"
                      disabled={submitting}
                    >
                      {submitting ? 'Processing...' : 'Resolve'}
                    </button>
                    <button
                      onClick={handleReject}
                      className="btn btn-danger"
                      disabled={submitting}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {selected.status !== 'pending' && (
                <div className="card">
                  <p><strong>Status:</strong> {selected.status}</p>
                  {selected.adminNotes && <p><strong>Notes:</strong> {selected.adminNotes}</p>}
                  {selected.linkedWineDefinition && (
                    <p><strong>Linked wine:</strong> {selected.linkedWineDefinition.name}</p>
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
