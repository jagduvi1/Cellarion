import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { fmtDate, actionClass, RoleBadge } from './helpers';

const PAGE_SIZE = 100;

const ACTION_OPTIONS = [
  'auth.register', 'auth.login.success', 'auth.login.failed',
  'bottle.add', 'bottle.update', 'bottle.consume', 'bottle.delete',
  'cellar.share.add', 'cellar.share.update', 'cellar.share.remove',
  'admin.wine.create', 'admin.wine.update', 'admin.wine.delete',
  'admin.request.resolve', 'admin.request.reject',
  'admin.taxonomy.create', 'admin.taxonomy.delete',
  'admin.image.approve', 'admin.image.reject', 'admin.image.assign',
  'system.rate_limit_exceeded',
  'superadmin.access',
];

export default function TabAudit() {
  const { apiFetch } = useAuth();
  const [actionFilter, setActionFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (action, from, to, p) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset: p * PAGE_SIZE });
      if (action) params.set('action', action);
      if (from)   params.set('from', from);
      if (to)     params.set('to', to);
      const res = await apiFetch(`/api/admin/audit?${params}`);
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

  useEffect(() => { load(actionFilter, fromDate, toDate, page); }, [page]); // eslint-disable-line

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(0);
    load(actionFilter, fromDate, toDate, 0);
  };

  const clearFilters = () => {
    setActionFilter('');
    setFromDate('');
    setToDate('');
    setPage(0);
    load('', '', '', 0);
  };

  const hasFilters = actionFilter || fromDate || toDate;

  return (
    <>
      <form className="sa-filter-row" onSubmit={handleSearch}>
        <select
          className="sa-input"
          style={{ width: 'auto' }}
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
        >
          <option value="">All actions</option>
          {ACTION_OPTIONS.map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <input
          className="sa-input"
          type="datetime-local"
          value={fromDate}
          onChange={e => setFromDate(e.target.value)}
          title="From date"
          style={{ width: 'auto' }}
        />
        <span style={{ color: 'var(--sa-text-dim)', alignSelf: 'center' }}>&ndash;</span>
        <input
          className="sa-input"
          type="datetime-local"
          value={toDate}
          onChange={e => setToDate(e.target.value)}
          title="To date"
          style={{ width: 'auto' }}
        />
        <button type="submit" className="sa-btn">Filter</button>
        {hasFilters && (
          <button type="button" className="sa-btn" onClick={clearFilters}>Clear</button>
        )}
      </form>

      {error && <div className="sa-error">Error: {error}</div>}

      <div className="sa-panel">
        <div className="sa-panel-header">
          <span className="sa-panel-title">Audit Log</span>
          <span style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{data ? `${(data.total || 0).toLocaleString()} total entries` : ''}</span>
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
