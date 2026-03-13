import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { fmtDate, actionClass, RoleBadge } from './helpers';

export default function TabAudit() {
  const { apiFetch } = useAuth();
  const [actionFilter, setActionFilter] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const PAGE_SIZE = 100;

  const load = useCallback(async (action, p) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset: p * PAGE_SIZE });
      if (action) params.set('action', action);
      const res = await apiFetch(`/api/superadmin/audit?${params}`);
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

  useEffect(() => { load(actionFilter, page); }, [page]); // eslint-disable-line

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(0);
    load(actionFilter, 0);
  };

  return (
    <>
      <form className="sa-filter-row" onSubmit={handleSearch}>
        <input
          className="sa-input"
          placeholder="Filter by action (e.g. auth, admin, bottle)..."
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
        />
        <button type="submit" className="sa-btn">Filter</button>
        <button type="button" className="sa-btn" onClick={() => { setActionFilter(''); setPage(0); load('', 0); }}>
          Clear
        </button>
      </form>

      {error && <div className="sa-error">Error: {error}</div>}

      <div className="sa-panel">
        <div className="sa-panel-header">
          <span className="sa-panel-title">Audit Log</span>
          <span style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{data ? `${data.total.toLocaleString()} total entries` : ''}</span>
        </div>
        <div className="sa-panel-body">
          {loading ? (
            <div className="sa-loading">Loading audit log...</div>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>IP</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.logs || []).map(log => (
                    <tr key={log._id}>
                      <td className="mono">{fmtDate(log.timestamp)}</td>
                      <td className={`mono ${actionClass(log.action)}`}>{log.action}</td>
                      <td className="mono">
                        {log.actor?.userId?.username || log.actor?.userId?.email || '—'}
                        {log.actor?.role && log.actor.role !== 'anonymous' && (
                          <span style={{ marginLeft: 4 }}><RoleBadge role={log.actor.role} /></span>
                        )}
                      </td>
                      <td className="mono">{log.actor?.ipAddress || '—'}</td>
                      <td className="mono" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--sa-text-dim)' }}>
                        {log.detail ? JSON.stringify(log.detail).slice(0, 120) : ''}
                      </td>
                    </tr>
                  ))}
                  {(!data?.logs?.length) && (
                    <tr><td colSpan={5}><div className="sa-empty">No entries found</div></td></tr>
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
