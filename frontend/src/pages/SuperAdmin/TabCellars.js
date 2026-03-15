import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { adminPermanentDeleteCellar } from '../../api/admin';
import { fmtDate } from './helpers';

function daysUntilPurge(deletedAt) {
  const purgeAt = new Date(deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (1000 * 60 * 60 * 24)));
}

export default function TabCellars() {
  const { apiFetch } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState({});
  const [deleting, setDeleting] = useState({});
  const [notices, setNotices] = useState([]);
  const PAGE_SIZE = 50;

  const load = useCallback(async (q, p) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset: p * PAGE_SIZE });
      if (q) params.set('search', q);
      const res = await apiFetch(`/api/admin/cellars/deleted?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(search, page); }, [page]); // eslint-disable-line

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(0);
    load(search, 0);
  };

  function removeFromList(id) {
    setData(prev => prev ? { ...prev, cellars: prev.cellars.filter(c => c._id !== id), total: prev.total - 1 } : prev);
  }

  async function restore(cellar) {
    setRestoring(prev => ({ ...prev, [cellar._id]: true }));
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/cellars/${cellar._id}/restore`, { method: 'POST' });
      const body = await res.json();
      if (res.ok) {
        setNotices(prev => [...prev, `Restored "${body.cellar.name}"`]);
        removeFromList(cellar._id);
      } else {
        setError(body.error || 'Failed to restore');
      }
    } catch {
      setError('Network error');
    } finally {
      setRestoring(prev => ({ ...prev, [cellar._id]: false }));
    }
  }

  async function permanentDelete(cellar) {
    if (!window.confirm(`Permanently delete "${cellar.name}" and ALL its bottles and racks? This cannot be undone.`)) return;
    setDeleting(prev => ({ ...prev, [cellar._id]: true }));
    setError(null);
    try {
      const res = await adminPermanentDeleteCellar(apiFetch, cellar._id);
      const body = await res.json();
      if (res.ok) {
        setNotices(prev => [...prev, `Permanently deleted "${cellar.name}"`]);
        removeFromList(cellar._id);
      } else {
        setError(body.error || 'Failed to delete');
      }
    } catch {
      setError('Network error');
    } finally {
      setDeleting(prev => ({ ...prev, [cellar._id]: false }));
    }
  }

  return (
    <>
      <form className="sa-filter-row" onSubmit={handleSearch}>
        <input
          className="sa-input"
          placeholder="Search by cellar name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button type="submit" className="sa-btn">Search</button>
        <button type="button" className="sa-btn" onClick={() => { setSearch(''); setPage(0); load('', 0); }}>
          Clear
        </button>
      </form>

      {notices.map((n, i) => (
        <div key={i} className="sa-error" style={{ background: 'rgba(39,174,96,0.15)', color: '#2ecc71', borderColor: '#27ae60' }}>{n}</div>
      ))}
      {error && <div className="sa-error">Error: {error}</div>}

      <div className="sa-panel">
        <div className="sa-panel-header">
          <span className="sa-panel-title">Deleted Cellars</span>
          <span style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{data ? `${data.total} total` : ''}</span>
        </div>
        <div className="sa-panel-body">
          {loading ? (
            <div className="sa-loading">Loading deleted cellars...</div>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Cellar Name</th>
                    <th>Owner</th>
                    <th>Deleted</th>
                    <th>Purges In</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.cellars || []).map(c => {
                    const days = daysUntilPurge(c.deletedAt);
                    const busy = restoring[c._id] || deleting[c._id];
                    return (
                      <tr key={c._id}>
                        <td><strong>{c.name}</strong></td>
                        <td>
                          <span>{c.user?.username || '—'}</span>
                          {c.user?.email && <span className="mono" style={{ marginLeft: 6, opacity: 0.6 }}>{c.user.email}</span>}
                        </td>
                        <td className="mono">{fmtDate(c.deletedAt)}</td>
                        <td>
                          <span style={{ color: days <= 3 ? '#e74c3c' : days <= 7 ? '#e67e22' : 'inherit' }}>
                            {days}d
                          </span>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="sa-btn"
                              disabled={busy}
                              onClick={() => restore(c)}
                            >
                              {restoring[c._id] ? 'Restoring...' : 'Restore'}
                            </button>
                            <button
                              className="sa-btn sa-btn-danger"
                              disabled={busy}
                              onClick={() => permanentDelete(c)}
                            >
                              {deleting[c._id] ? 'Deleting...' : 'Delete'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {(!data?.cellars?.length) && (
                    <tr><td colSpan={5}><div className="sa-empty">No deleted cellars found</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {data && data.total > PAGE_SIZE && (
            <div className="sa-pagination">
              <button className="sa-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                &laquo; Prev
              </button>
              <span>Page {page + 1} of {Math.ceil(data.total / PAGE_SIZE)}</span>
              <button
                className="sa-btn"
                disabled={(page + 1) * PAGE_SIZE >= data.total}
                onClick={() => setPage(p => p + 1)}
              >
                Next &raquo;
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
