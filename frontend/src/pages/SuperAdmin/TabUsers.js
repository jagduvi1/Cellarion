import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { fmtDate, PlanBadge, RoleBadge } from './helpers';

export default function TabUsers() {
  const { apiFetch } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const PAGE_SIZE = 50;

  const load = useCallback(async (q, p) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset: p * PAGE_SIZE });
      if (q) params.set('search', q);
      const res = await apiFetch(`/api/superadmin/users?${params}`);
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

  return (
    <>
      <form className="sa-filter-row" onSubmit={handleSearch}>
        <input
          className="sa-input"
          placeholder="Search by username or email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button type="submit" className="sa-btn">Search</button>
        <button type="button" className="sa-btn" onClick={() => { setSearch(''); setPage(0); load('', 0); }}>
          Clear
        </button>
      </form>

      {error && <div className="sa-error">Error: {error}</div>}

      <div className="sa-panel">
        <div className="sa-panel-header">
          <span className="sa-panel-title">Users</span>
          <span style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{data ? `${data.total} total` : ''}</span>
        </div>
        <div className="sa-panel-body">
          {loading ? (
            <div className="sa-loading">Loading users...</div>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Roles</th>
                    <th>Plan</th>
                    <th>Plan Expires</th>
                    <th>Verified</th>
                    <th>Trial</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.users || []).map(u => (
                    <tr key={u._id}>
                      <td>{u.username}</td>
                      <td className="mono">{u.email}</td>
                      <td style={{ display: 'flex', gap: 3 }}>
                        {(u.roles || []).map(r => <RoleBadge key={r} role={r} />)}
                      </td>
                      <td><PlanBadge plan={u.plan} /></td>
                      <td className="mono">{u.planExpiresAt ? fmtDate(u.planExpiresAt) : '—'}</td>
                      <td>{u.emailVerified ? <span className="sa-badge ok">yes</span> : <span className="sa-badge error">no</span>}</td>
                      <td>{u.trialEligible ? <span className="sa-badge ok">yes</span> : <span className="sa-badge user">no</span>}</td>
                      <td className="mono">{fmtDate(u.createdAt)}</td>
                    </tr>
                  ))}
                  {(!data?.users?.length) && (
                    <tr><td colSpan={8}><div className="sa-empty">No users found</div></td></tr>
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
