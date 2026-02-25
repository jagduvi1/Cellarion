import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './AdminAudit.css';

// Color category for each action prefix
const ACTION_CATEGORY = {
  'auth':  'auth',
  'bottle': 'bottle',
  'cellar': 'cellar',
  'admin':  'admin'
};

function getCategory(action) {
  const prefix = action?.split('.')[0];
  return ACTION_CATEGORY[prefix] || 'other';
}

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function ActionBadge({ action }) {
  const category = getCategory(action);
  const label = action?.split('.').slice(1).join('.') || action;
  return (
    <span className={`audit-action-badge audit-action-badge--${category}`}>
      {label}
    </span>
  );
}

const ACTION_OPTIONS = [
  '',
  'auth.register', 'auth.login.success', 'auth.login.failed',
  'bottle.add', 'bottle.update', 'bottle.consume', 'bottle.delete',
  'cellar.share.add', 'cellar.share.update', 'cellar.share.remove',
  'admin.wine.create', 'admin.wine.update', 'admin.wine.delete',
  'admin.request.resolve', 'admin.request.reject',
  'admin.taxonomy.create', 'admin.taxonomy.delete',
  'admin.image.approve', 'admin.image.reject', 'admin.image.assign'
];

function AdminAudit() {
  const { token } = useAuth();
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const LIMIT = 50;

  const [filters, setFilters] = useState({
    action: '',
    from: '',
    to: ''
  });

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT });
      if (filters.action) params.set('action', filters.action);
      if (filters.from)   params.set('from', filters.from);
      if (filters.to)     params.set('to', filters.to);

      const res = await fetch(`/api/admin/audit?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setLogs(data.logs);
        setTotal(data.total);
      } else {
        setError(data.error || 'Failed to load audit log');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [token, page, filters]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  const handleFilterChange = (key, val) => {
    setFilters(f => ({ ...f, [key]: val }));
    setPage(1);
  };

  return (
    <div className="admin-audit-page">
      <div className="page-header">
        <h1>Audit Log</h1>
        <span className="audit-total">{total.toLocaleString()} events</span>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="audit-filters">
        <select
          className="filter-select"
          value={filters.action}
          onChange={e => handleFilterChange('action', e.target.value)}
        >
          <option value="">All Actions</option>
          {ACTION_OPTIONS.filter(Boolean).map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <div className="audit-date-range">
          <input
            type="datetime-local"
            className="filter-input"
            value={filters.from}
            onChange={e => handleFilterChange('from', e.target.value)}
            title="From date"
          />
          <span className="date-sep">–</span>
          <input
            type="datetime-local"
            className="filter-input"
            value={filters.to}
            onChange={e => handleFilterChange('to', e.target.value)}
            title="To date"
          />
        </div>
      </div>

      {loading ? (
        <div className="loading">Loading audit log…</div>
      ) : logs.length === 0 ? (
        <div className="empty-state"><p>No audit events found.</p></div>
      ) : (
        <>
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Detail</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log._id} className={`audit-row audit-row--${getCategory(log.action)}`}>
                    <td className="audit-ts">{formatTimestamp(log.timestamp)}</td>
                    <td className="audit-user">
                      {log.actor?.userId
                        ? <><strong>{log.actor.userId.username}</strong><br/><span className="audit-email">{log.actor.userId.email}</span></>
                        : <span className="audit-anon">anonymous</span>
                      }
                    </td>
                    <td><ActionBadge action={log.action} /></td>
                    <td className="audit-resource">
                      {log.resource?.type && (
                        <span className="audit-resource-type">{log.resource.type}</span>
                      )}
                    </td>
                    <td className="audit-detail">
                      <pre>{JSON.stringify(log.detail, null, 0)}</pre>
                    </td>
                    <td className="audit-ip">{log.actor?.ipAddress || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="audit-pagination">
            <button
              className="btn btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
            >
              ← Prev
            </button>
            <span className="audit-page-info">Page {page} of {totalPages}</span>
            <button
              className="btn btn-secondary"
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default AdminAudit;
