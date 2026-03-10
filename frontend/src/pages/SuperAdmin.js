import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { adminGetRateLimits, adminSaveRateLimits, adminGetContactEmail, adminSaveContactEmail } from '../api/admin';
import './SuperAdmin.css';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function num(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

function ago(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toISOString().replace('T', ' ').slice(0, 19);
}

function actionClass(action) {
  if (!action) return '';
  if (action.startsWith('auth')) return 'action-auth';
  if (action.startsWith('superadmin')) return 'action-superadmin';
  if (action.startsWith('admin')) return 'action-admin';
  if (action.startsWith('bottle')) return 'action-bottle';
  if (action.startsWith('cellar')) return 'action-cellar';
  if (action.startsWith('system')) return 'action-system';
  return '';
}

function StatusDot({ status }) {
  const cls =
    status === 'ok' || status === 'available' ? 'ok' :
    status === 'error' ? 'error' :
    status === 'not_configured' ? 'off' : 'warn';
  return <span className={`sa-service-dot ${cls}`} />;
}

function BarFill({ pct, warn = 70, danger = 90 }) {
  const cls = pct >= danger ? 'danger' : pct >= warn ? 'warn' : '';
  return (
    <div className="sa-bar-wrap">
      <div className="sa-bar-track">
        <div className="sa-bar-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

function PlanBadge({ plan }) {
  return <span className={`sa-badge ${plan || 'free'}`}>{plan || 'free'}</span>;
}

function RoleBadge({ role }) {
  return <span className={`sa-badge ${role}`}>{role}</span>;
}

function Sparkline({ data }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="sa-spark" title="Registrations (last 12 months)">
      {data.map((d, i) => (
        <div
          key={i}
          className="sa-spark-bar"
          style={{ height: `${Math.max(4, (d.count / max) * 40)}px` }}
          title={`${d._id?.year}-${String(d._id?.month).padStart(2, '0')}: ${d.count}`}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Data-fetching hook
// ─────────────────────────────────────────────────────────────────────────────

function useApi(path, { skip = false } = {}) {
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (skip) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(path);
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
  }, [apiFetch, path, skip]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, reload: load };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Overview
// ─────────────────────────────────────────────────────────────────────────────

function TabOverview() {
  const { data, loading, error, reload } = useApi('/api/superadmin/overview');

  if (loading) return <div className="sa-loading">Loading platform overview...</div>;
  if (error) return <div className="sa-error">Error: {error}</div>;
  if (!data) return null;

  const { counts, byPlan, byRole, registrationsOverTime, recentUsers } = data;

  return (
    <>
      {/* Big numbers */}
      <div className="sa-metrics">
        {[
          { label: 'Users', value: counts.totalUsers },
          { label: 'Active Bottles', value: counts.activeBottles, sub: `${counts.consumedBottles} consumed` },
          { label: 'Wine Definitions', value: counts.totalWines },
          { label: 'Cellars', value: counts.totalCellars },
          { label: 'Racks', value: counts.totalRacks },
          { label: 'Images', value: counts.totalImages },
          { label: 'Wine Requests', value: counts.totalRequests },
          { label: 'Total Bottles Ever', value: counts.totalBottles },
        ].map(m => (
          <div key={m.label} className="sa-metric">
            <div className="sa-metric-label">{m.label}</div>
            <div className="sa-metric-value">{num(m.value)}</div>
            {m.sub && <div className="sa-metric-sub">{m.sub}</div>}
          </div>
        ))}
      </div>

      <div className="sa-grid-3">
        {/* Users by plan */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">Users by Plan</span></div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              {['free', 'basic', 'premium'].map(p => (
                <div key={p} className="sa-kv-row">
                  <span className="sa-kv-key"><PlanBadge plan={p} /></span>
                  <span className="sa-kv-val">{num(byPlan[p] || 0)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Users by role */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">Users by Role</span></div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              {['user', 'admin', 'somm'].map(r => (
                <div key={r} className="sa-kv-row">
                  <span className="sa-kv-key"><RoleBadge role={r} /></span>
                  <span className="sa-kv-val">{num(byRole[r] || 0)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Registrations sparkline */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">Registrations (12 mo)</span></div>
          <div className="sa-panel-body">
            <Sparkline data={registrationsOverTime} />
            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--sa-text-dim)' }}>
              {registrationsOverTime.length > 0
                ? `${registrationsOverTime.reduce((s, d) => s + d.count, 0)} total in period`
                : 'No data'}
            </div>
          </div>
        </div>
      </div>

      {/* Recent users */}
      <div className="sa-panel">
        <div className="sa-panel-header">
          <span className="sa-panel-title">Recent Registrations</span>
          <button className="sa-btn" onClick={reload}>Refresh</button>
        </div>
        <div className="sa-panel-body">
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Roles</th>
                  <th>Plan</th>
                  <th>Verified</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {recentUsers.map(u => (
                  <tr key={u._id}>
                    <td>{u.username}</td>
                    <td className="mono">{u.email}</td>
                    <td>{(u.roles || []).map(r => <RoleBadge key={r} role={r} />)}</td>
                    <td><PlanBadge plan={u.plan} /></td>
                    <td>{u.emailVerified ? <span className="sa-badge ok">yes</span> : <span className="sa-badge error">no</span>}</td>
                    <td className="mono">{ago(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Services
// ─────────────────────────────────────────────────────────────────────────────

function TabServices() {
  const { data, loading, error, reload } = useApi('/api/superadmin/services');
  const { data: procData, reload: reloadProc } = useApi('/api/superadmin/process');

  const handleReload = () => { reload(); reloadProc(); };

  if (loading) return <div className="sa-loading">Pinging services...</div>;
  if (error) return <div className="sa-error">Error: {error}</div>;
  if (!data) return null;

  const services = [
    {
      key: 'mongodb',
      name: 'MongoDB',
      status: data.mongodb?.status,
      detail: data.mongodb?.latencyMs != null ? `${data.mongodb.latencyMs}ms` : data.mongodb?.error,
    },
    {
      key: 'meilisearch',
      name: 'Meilisearch',
      status: data.meilisearch?.status,
      detail: data.meilisearch?.latencyMs != null ? `${data.meilisearch.latencyMs}ms` : data.meilisearch?.error,
    },
    {
      key: 'rembg',
      name: 'rembg (BG Removal)',
      status: data.rembg?.status,
      detail: data.rembg?.latencyMs != null ? `${data.rembg.latencyMs}ms` : data.rembg?.error,
    },
    {
      key: 'qdrant',
      name: 'Qdrant',
      status: data.qdrant?.status,
      detail: data.qdrant?.status === 'not_configured'
        ? 'QDRANT_URL not set'
        : data.qdrant?.latencyMs != null ? `${data.qdrant.latencyMs}ms` : data.qdrant?.error,
    },
  ];

  const meiliStats = data.meilisearchStats;

  return (
    <>
      <div className="sa-services-grid">
        {services.map(s => (
          <div key={s.key} className="sa-service">
            <StatusDot status={s.status} />
            <div>
              <div className="sa-service-name">{s.name}</div>
              <div className="sa-service-status">{s.status || '—'}</div>
              {s.detail && <div className="sa-service-latency">{s.detail}</div>}
            </div>
          </div>
        ))}

        {/* Anthropic */}
        <div className="sa-service">
          <StatusDot status={data.anthropic?.configured ? 'ok' : 'not_configured'} />
          <div>
            <div className="sa-service-name">Anthropic API</div>
            <div className="sa-service-status">{data.anthropic?.configured ? 'Configured' : 'Not configured'}</div>
            {data.anthropic?.keyPrefix && (
              <div className="sa-service-latency">{data.anthropic.keyPrefix}</div>
            )}
          </div>
        </div>

        {/* Voyage AI */}
        <div className="sa-service">
          <StatusDot status={data.voyageAI?.configured ? 'ok' : 'not_configured'} />
          <div>
            <div className="sa-service-name">Voyage AI</div>
            <div className="sa-service-status">{data.voyageAI?.configured ? 'Configured' : 'Not configured'}</div>
            {data.voyageAI?.keyPrefix && (
              <div className="sa-service-latency">{data.voyageAI.keyPrefix}</div>
            )}
          </div>
        </div>

        {/* Mailgun */}
        <div className="sa-service">
          <StatusDot status={data.mailgun?.configured ? 'ok' : 'not_configured'} />
          <div>
            <div className="sa-service-name">Mailgun</div>
            <div className="sa-service-status">{data.mailgun?.configured ? 'Configured' : 'Not configured'}</div>
            {data.mailgun?.domain && <div className="sa-service-latency">{data.mailgun.domain}</div>}
          </div>
        </div>
      </div>

      <div className="sa-grid-2">
        {/* Meilisearch index stats */}
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Meilisearch Indexes</span>
            <button className="sa-btn" onClick={handleReload}>Refresh</button>
          </div>
          <div className="sa-panel-body">
            {meiliStats?.indexes ? (
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <thead>
                    <tr><th>Index</th><th>Documents</th><th>Indexing</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(meiliStats.indexes).map(([uid, info]) => (
                      <tr key={uid}>
                        <td>{uid}</td>
                        <td>{num(info.numberOfDocuments)}</td>
                        <td>{info.isIndexing ? <span className="sa-badge warn">Yes</span> : <span className="sa-badge ok">No</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="sa-empty">No index data available</div>
            )}
            {meiliStats?.databaseSize != null && (
              <div className="sa-kv" style={{ marginTop: 10 }}>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Database size</span>
                  <span className="sa-kv-val">{bytes(meiliStats.databaseSize)}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Last update</span>
                  <span className="sa-kv-val">{fmtDate(meiliStats.lastUpdate)}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Node.js process */}
        {procData && (
          <div className="sa-panel">
            <div className="sa-panel-header"><span className="sa-panel-title">Node.js Process</span></div>
            <div className="sa-panel-body">
              <div className="sa-kv">
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Node version</span>
                  <span className="sa-kv-val accent">{procData.nodeVersion}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Uptime</span>
                  <span className="sa-kv-val">{procData.uptimeFormatted}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">PID</span>
                  <span className="sa-kv-val">{procData.pid}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Platform</span>
                  <span className="sa-kv-val">{procData.platform} / {procData.arch}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Environment</span>
                  <span className="sa-kv-val">{procData.env?.nodeEnv}</span>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div className="sa-bar-label">
                  <span>Heap used</span>
                  <span>{bytes(procData.memory?.heapUsedBytes)} / {bytes(procData.memory?.heapTotalBytes)} ({procData.memory?.heapUsedPct}%)</span>
                </div>
                <BarFill pct={procData.memory?.heapUsedPct} />
              </div>

              <div style={{ marginTop: 8 }}>
                <div className="sa-bar-label">
                  <span>RSS</span>
                  <span>{bytes(procData.memory?.rssBytes)}</span>
                </div>
                <div className="sa-bar-track" style={{ height: 4, background: 'var(--sa-surface2)' }}>
                  <div style={{
                    height: '100%',
                    background: 'var(--sa-accent2)',
                    width: `${Math.min((procData.memory?.rssBytes / (512 * 1024 * 1024)) * 100, 100)}%`
                  }} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Database (MongoDB)
// ─────────────────────────────────────────────────────────────────────────────

function TabDatabase() {
  const { data, loading, error, reload } = useApi('/api/superadmin/mongodb');

  if (loading) return <div className="sa-loading">Reading MongoDB stats...</div>;
  if (error) return <div className="sa-error">Error: {error}</div>;
  if (!data) return null;

  return (
    <>
      <div className="sa-grid-2" style={{ marginBottom: 16 }}>
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Database: {data.database}</span>
            <button className="sa-btn" onClick={reload}>Refresh</button>
          </div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Total documents</span>
                <span className="sa-kv-val accent">{num(data.objects)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Collections</span>
                <span className="sa-kv-val">{num(data.collections)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Data size</span>
                <span className="sa-kv-val">{bytes(data.dataSize)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Storage size</span>
                <span className="sa-kv-val">{bytes(data.storageSize)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Index size</span>
                <span className="sa-kv-val">{bytes(data.indexSize)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Avg object size</span>
                <span className="sa-kv-val">{bytes(data.avgObjSize)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Storage breakdown bar */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">Storage Breakdown</span></div>
          <div className="sa-panel-body">
            {data.collectionStats?.slice(0, 8).map(col => {
              const pct = data.storageSize > 0 ? Math.round((col.storageSize / data.storageSize) * 100) : 0;
              return (
                <div key={col.name} style={{ marginBottom: 10 }}>
                  <div className="sa-bar-label">
                    <span>{col.name}</span>
                    <span>{num(col.count)} docs · {bytes(col.storageSize)} ({pct}%)</span>
                  </div>
                  <div className="sa-bar-track">
                    <div className="sa-bar-fill" style={{ width: `${pct}%`, background: 'var(--sa-accent2)' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Per-collection table */}
      <div className="sa-panel">
        <div className="sa-panel-header"><span className="sa-panel-title">Collections</span></div>
        <div className="sa-panel-body">
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th>Documents</th>
                  <th>Data Size</th>
                  <th>Storage Size</th>
                  <th>Avg Doc</th>
                  <th>Indexes</th>
                  <th>Index Size</th>
                </tr>
              </thead>
              <tbody>
                {(data.collectionStats || []).map(col => (
                  <tr key={col.name}>
                    <td style={{ color: 'var(--sa-accent2)' }}>{col.name}</td>
                    <td>{num(col.count)}</td>
                    <td>{bytes(col.size)}</td>
                    <td>{bytes(col.storageSize)}</td>
                    <td>{bytes(col.avgObjSize)}</td>
                    <td>{col.nindexes}</td>
                    <td>{bytes(col.totalIndexSize)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Users
// ─────────────────────────────────────────────────────────────────────────────

function TabUsers() {
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

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Audit Log
// ─────────────────────────────────────────────────────────────────────────────

function TabAudit() {
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

// ─────────────────────────────────────────────────────────────────────────────
// Root component
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_MODELS = [
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    description: 'Fast & affordable — recommended for Cellar Chat',
    inputPrice: '$0.80',
    outputPrice: '$4.00',
    tier: 'economy',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Latest Sonnet — high quality at standard price',
    inputPrice: '$3.00',
    outputPrice: '$15.00',
    tier: 'standard',
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'Most capable — best for complex palate matching',
    inputPrice: '$15.00',
    outputPrice: '$75.00',
    tier: 'premium',
  },
];

function ChatModelPanel({ currentModel, currentFallback, apiFetch }) {
  const [selected, setSelected]   = useState(currentModel || 'claude-haiku-4-5-20251001');
  const [fallback, setFallback]   = useState(currentFallback || 'none');
  const [saving, setSaving]       = useState(false);
  const [msg, setMsg]             = useState(null);

  const isDirty = selected !== currentModel || (fallback === 'none' ? null : fallback) !== currentFallback;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/superadmin/ai/chat-model', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selected,
          fallbackModel: fallback === 'none' ? null : fallback,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved — takes effect immediately' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  const tierColor = { economy: 'var(--sa-accent)', standard: 'var(--sa-accent2)', premium: '#c9a84c' };

  const modelRow = (m, groupName, checked, onChange, activeMark) => (
    <label
      key={m.id}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 4,
        border: `1px solid ${checked ? 'var(--sa-accent)' : 'var(--sa-border)'}`,
        background: checked ? 'rgba(123,158,136,0.06)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <input
        type="radio"
        name={groupName}
        value={m.id}
        checked={checked}
        onChange={onChange}
        style={{ marginTop: 2, accentColor: 'var(--sa-accent)', flexShrink: 0 }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--sa-text)' }}>{m.name}</span>
          <span style={{ fontSize: 10, color: tierColor[m.tier], border: `1px solid ${tierColor[m.tier]}`, borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {m.tier}
          </span>
          {activeMark && <span style={{ fontSize: 10, color: 'var(--sa-accent)', marginLeft: 'auto' }}>● active</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 2 }}>{m.description}</div>
        <div style={{ fontSize: 10, color: 'var(--sa-text-dim)', fontFamily: 'monospace' }}>
          Input: {m.inputPrice} / M &nbsp;·&nbsp; Output: {m.outputPrice} / M tokens
        </div>
      </div>
    </label>
  );

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Cellar Chat — AI Model</span>
        <button className="sa-btn" onClick={save} disabled={saving || !isDirty}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      <div className="sa-panel-body">

        {/* Primary */}
        <div style={{ fontSize: 10, color: 'var(--sa-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Primary model
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
          {CHAT_MODELS.map(m => modelRow(
            m, 'chatModel',
            selected === m.id,
            () => { setSelected(m.id); if (fallback === m.id) setFallback('none'); },
            m.id === currentModel
          ))}
        </div>

        {/* Fallback */}
        <div style={{ fontSize: 10, color: 'var(--sa-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Fallback model <span style={{ textTransform: 'none', letterSpacing: 0 }}>— used automatically on 529 overloaded</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 4, border: `1px solid ${fallback === 'none' ? 'var(--sa-accent)' : 'var(--sa-border)'}`, background: fallback === 'none' ? 'rgba(123,158,136,0.06)' : 'transparent', cursor: 'pointer' }}>
            <input type="radio" name="chatFallback" value="none" checked={fallback === 'none'} onChange={() => setFallback('none')} style={{ accentColor: 'var(--sa-accent)' }} />
            <span style={{ fontSize: 12, color: 'var(--sa-text-dim)' }}>None — no fallback</span>
          </label>
          {CHAT_MODELS.filter(m => m.id !== selected).map(m => modelRow(
            m, 'chatFallback',
            fallback === m.id,
            () => setFallback(m.id),
            m.id === currentFallback
          ))}
        </div>

        {msg && (
          <div style={{ marginTop: 12, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}

function SystemPromptPanel({ prompt, apiFetch }) {
  const { DEFAULT_SYSTEM_PROMPT } = { DEFAULT_SYSTEM_PROMPT: '' }; // fallback
  const [val, setVal] = useState(prompt || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/superadmin/ai/system-prompt', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: val }),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved — takes effect immediately' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Cellar Chat — System Prompt</span>
        <button className="sa-btn" onClick={save} disabled={saving || !val.trim()}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 8 }}>
          This prompt is sent to Claude before every chat message. Takes effect immediately on save.
        </div>
        <textarea
          value={val}
          onChange={e => setVal(e.target.value)}
          rows={10}
          style={{ width: '100%', background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '8px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical', boxSizing: 'border-box' }}
        />
        <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--sa-text-dim)' }}>{val.length} / 4000 chars</span>
          {msg && (
            <span style={{ fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function RateLimitsPanel({ apiFetch }) {
  const LIMITERS = [
    { key: 'api',   label: 'General API',  hint: 'requests / 15 min per IP' },
    { key: 'write', label: 'Write actions', hint: 'requests / 15 min per IP' },
    { key: 'auth',  label: 'Auth / login',  hint: 'requests / 15 min per IP' },
  ];

  const [form,     setForm]     = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [msg,      setMsg]      = useState(null);

  useEffect(() => {
    adminGetRateLimits(apiFetch)
      .then(r => r.json())
      .then(d => {
        setForm({ api: String(d.config.api.max), write: String(d.config.write.max), auth: String(d.config.auth.max) });
        setDefaults(d.defaults);
      })
      .catch(() => setMsg({ ok: false, text: 'Failed to load' }));
  }, [apiFetch]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const body = {
        api:   { max: Number(form.api)   },
        write: { max: Number(form.write) },
        auth:  { max: Number(form.auth)  },
      };
      const res = await adminSaveRateLimits(apiFetch, body);
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved — takes effect immediately' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  if (!form) return <div className="sa-loading">Loading rate limits...</div>;

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Rate Limits</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Maximum requests per 15-minute window per IP address.
        </div>
        <div className="sa-kv">
          {LIMITERS.map(({ key, label, hint }) => (
            <div className="sa-kv-row" key={key}>
              <span className="sa-kv-key">
                {label}
                {defaults && (
                  <span style={{ marginLeft: 6, color: 'var(--sa-text-dim)', fontSize: 10 }}>
                    (default: {defaults[key].max})
                  </span>
                )}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={form[key]}
                  onChange={e => setForm(v => ({ ...v, [key]: e.target.value }))}
                  style={{ width: 80, background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12 }}
                />
                <span style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{hint}</span>
              </div>
            </div>
          ))}
        </div>
        {msg && (
          <div style={{ marginTop: 10, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}

function ChatLimitsPanel({ limits, apiFetch }) {
  const [vals, setVals] = useState({ free: limits.free ?? 4, basic: limits.basic ?? 20, premium: limits.premium ?? 50 });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/superadmin/ai/chat-limits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vals),
      });
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Cellar Chat — Daily Limits</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Max questions per user per day. Resets at midnight UTC.
        </div>
        <div className="sa-kv">
          {[['free', 'Free plan'], ['basic', 'Basic plan'], ['premium', 'Premium plan']].map(([key, label]) => (
            <div className="sa-kv-row" key={key}>
              <span className="sa-kv-key">{label}</span>
              <input
                type="number"
                min="0"
                max="999"
                value={vals[key]}
                onChange={e => setVals(v => ({ ...v, [key]: e.target.value }))}
                style={{ width: 70, background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>
          ))}
        </div>
        {msg && (
          <div style={{ marginTop: 10, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Settings
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Chat Usage Panel
// ─────────────────────────────────────────────────────────────────────────────

function ChatUsagePanel() {
  const { apiFetch } = useAuth();
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (d) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/superadmin/chat-usage?days=${d}&limit=100`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setRows(json.rows || []);
      setTotal(json.total || 0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(days); }, [load, days]);

  const totals = rows.reduce(
    (acc, r) => ({ q: acc.q + r.questions, i: acc.i + r.inputTokens, o: acc.o + r.outputTokens }),
    { q: 0, i: 0, o: 0 }
  );

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Cellar Chat Usage — Per User</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="sa-input"
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{ width: 120 }}
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button className="sa-btn" onClick={() => load(days)}>Refresh</button>
        </div>
      </div>
      <div className="sa-panel-body">
        {error && <div className="sa-error">{error}</div>}
        {loading ? (
          <div className="sa-loading">Loading usage data...</div>
        ) : rows.length === 0 ? (
          <div style={{ color: 'var(--sa-text-dim)', fontSize: 12, padding: '8px 0' }}>
            No chat usage data for this period.
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 12, display: 'flex', gap: 24, fontSize: 12, color: 'var(--sa-text-dim)' }}>
              <span><strong style={{ color: 'var(--sa-accent)' }}>{num(total)}</strong> active users</span>
              <span><strong style={{ color: 'var(--sa-text)' }}>{num(totals.q)}</strong> questions</span>
              <span><strong style={{ color: 'var(--sa-text)' }}>{num(totals.i + totals.o)}</strong> total tokens</span>
            </div>
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Plan</th>
                    <th>Questions</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Total tokens</th>
                    <th>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.userId}>
                      <td>
                        <div>{r.username}</div>
                        {r.email && <div style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{r.email}</div>}
                      </td>
                      <td><PlanBadge plan={r.plan} /></td>
                      <td style={{ color: 'var(--sa-accent)' }}>{num(r.questions)}</td>
                      <td>{num(r.inputTokens)}</td>
                      <td>{num(r.outputTokens)}</td>
                      <td style={{ fontWeight: 600 }}>{num(r.totalTokens)}</td>
                      <td style={{ color: 'var(--sa-text-dim)' }}>{r.lastActive || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ContactEmailPanel({ apiFetch }) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    adminGetContactEmail(apiFetch)
      .then(r => r.json())
      .then(d => setValue(d.contactEmail || ''))
      .catch(() => setMsg({ ok: false, text: 'Failed to load' }));
  }, [apiFetch]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await adminSaveContactEmail(apiFetch, value.trim());
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Contact Email</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Shown in beta notices and support prompts across the app.
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Contact address</span>
            <input
              type="email"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="support@example.com"
              style={{ background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 8px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12, width: 240 }}
            />
          </div>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 11, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}

function TabSettings() {
  const { apiFetch } = useAuth();
  return (
    <>
      <ContactEmailPanel apiFetch={apiFetch} />
      <RateLimitsPanel apiFetch={apiFetch} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: AI & Embeddings
// ─────────────────────────────────────────────────────────────────────────────

function TabAI() {
  const { data, loading, error, reload } = useApi('/api/superadmin/ai');
  const { apiFetch } = useAuth();
  const [jobMode, setJobMode] = useState('incremental');
  const [jobBusy, setJobBusy] = useState(false);
  const [jobMsg, setJobMsg] = useState(null);

  async function startJob() {
    setJobBusy(true); setJobMsg(null);
    try {
      const res = await apiFetch('/api/admin/ai/embed/start', { method: 'POST', body: JSON.stringify({ mode: jobMode }) });
      setJobMsg(res.message || 'Job started');
      reload();
    } catch (e) { setJobMsg(e.message || 'Error'); }
    finally { setJobBusy(false); }
  }

  async function stopJob() {
    setJobBusy(true); setJobMsg(null);
    try {
      const res = await apiFetch('/api/admin/ai/embed/stop', { method: 'POST' });
      setJobMsg(res.message || 'Stop requested');
      reload();
    } catch (e) { setJobMsg(e.message || 'Error'); }
    finally { setJobBusy(false); }
  }

  if (loading) return <div className="sa-loading">Loading AI pipeline stats...</div>;
  if (error)   return <div className="sa-error">Error: {error}</div>;
  if (!data)   return null;

  const { configured, config, job, collection, embeddings } = data;

  const jobPct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const jobStatusColor =
    job.status === 'running'  ? 'warn' :
    job.status === 'done'     ? 'accent' :
    job.status === 'error'    ? 'danger' : '';
  const isRunning = job.status === 'running' || job.status === 'stopping';

  return (
    <>
      {/* API keys configured */}
      <div className="sa-services-grid" style={{ marginBottom: 16 }}>
        {[
          { name: 'Voyage AI (Embeddings)', ok: configured.voyageAI },
          { name: 'Qdrant (Vector DB)',     ok: configured.qdrant },
          { name: 'Anthropic (AI Chat)',    ok: configured.anthropic },
        ].map(s => (
          <div key={s.name} className="sa-service">
            <StatusDot status={s.ok ? 'ok' : 'not_configured'} />
            <div>
              <div className="sa-service-name">{s.name}</div>
              <div className="sa-service-status">{s.ok ? 'Configured' : 'Not configured'}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="sa-grid-2">
        {/* AI Config */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">AI Config</span></div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Chat enabled</span>
                <span className={`sa-kv-val ${config.chatEnabled ? 'accent' : 'danger'}`}>
                  {config.chatEnabled ? 'YES' : 'NO'}
                </span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Embedding model</span>
                <span className="sa-kv-val">{config.embeddingModel}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Active vector index</span>
                <span className="sa-kv-val accent">wines_{config.vectorIndex}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Chat top-K (Qdrant)</span>
                <span className="sa-kv-val">{config.chatTopK}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Max results shown</span>
                <span className="sa-kv-val">{config.chatMaxResults}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Chat model</span>
                <span className="sa-kv-val">{config.chatModel}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Fallback model</span>
                <span className="sa-kv-val">{config.chatModelFallback || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Embed batch delay</span>
                <span className="sa-kv-val">{config.embeddingBatchDelayMs}ms</span>
              </div>
            </div>
          </div>
        </div>

        {/* Qdrant collection */}
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Qdrant Collection</span>
            <button className="sa-btn" onClick={reload}>Refresh</button>
          </div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Collection</span>
                <span className="sa-kv-val accent">{collection?.name || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Exists</span>
                <span className={`sa-kv-val ${collection?.exists ? 'accent' : 'danger'}`}>
                  {collection?.exists ? 'YES' : 'NO'}
                </span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Vectors stored</span>
                <span className="sa-kv-val">{num(collection?.vectorCount)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="sa-grid-2">
        {/* Embedding job status */}
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Embedding Job</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={jobMode}
                onChange={e => setJobMode(e.target.value)}
                disabled={isRunning || jobBusy}
                style={{ fontSize: 11, padding: '2px 4px', background: '#1a1a1a', color: '#ccc', border: '1px solid #444', borderRadius: 3 }}
              >
                <option value="incremental">Incremental</option>
                <option value="full">Full re-embed</option>
              </select>
              {!isRunning ? (
                <button className="sa-btn" onClick={startJob} disabled={jobBusy}>Start</button>
              ) : (
                <button className="sa-btn" onClick={stopJob} disabled={jobBusy}>Stop</button>
              )}
              <button className="sa-btn" onClick={reload}>Refresh</button>
            </div>
          </div>
          <div className="sa-panel-body">
            {jobMsg && <div className={`sa-error`} style={{ marginBottom: 8, fontSize: 11 }}>{jobMsg}</div>}
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Status</span>
                <span className={`sa-kv-val ${jobStatusColor}`}>{job.status?.toUpperCase()}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Mode</span>
                <span className="sa-kv-val">{job.mode || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Model</span>
                <span className="sa-kv-val">{job.model || '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Progress</span>
                <span className="sa-kv-val">{job.done}/{job.total}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Skipped</span>
                <span className="sa-kv-val">{num(job.skipped)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Errors</span>
                <span className={`sa-kv-val ${job.errors > 0 ? 'danger' : ''}`}>{num(job.errors)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Started</span>
                <span className="sa-kv-val mono">{job.startedAt ? ago(job.startedAt) : '—'}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Finished</span>
                <span className="sa-kv-val mono">{job.finishedAt ? ago(job.finishedAt) : '—'}</span>
              </div>
            </div>
            {job.status === 'running' || job.status === 'stopping' ? (
              <div style={{ marginTop: 12 }}>
                <div className="sa-bar-label">
                  <span>Embedding progress</span>
                  <span>{jobPct}%</span>
                </div>
                <div className="sa-bar-track">
                  <div className="sa-bar-fill warn" style={{ width: `${jobPct}%` }} />
                </div>
              </div>
            ) : null}
            {job.lastError && (
              <div className="sa-error" style={{ marginTop: 10, fontSize: 11 }}>
                Last error: {job.lastError}
              </div>
            )}
          </div>
        </div>

        {/* WineEmbedding MongoDB stats */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">WineEmbeddings (MongoDB)</span></div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Total records</span>
                <span className="sa-kv-val accent">{num(embeddings.total)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Status: ok</span>
                <span className="sa-kv-val">{num(embeddings.byStatus?.ok || 0)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Status: error</span>
                <span className={`sa-kv-val ${embeddings.byStatus?.error > 0 ? 'danger' : ''}`}>
                  {num(embeddings.byStatus?.error || 0)}
                </span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Last embedded</span>
                <span className="sa-kv-val mono">{embeddings.lastEmbeddedAt ? ago(embeddings.lastEmbeddedAt) : '—'}</span>
              </div>
            </div>

            {embeddings.byModel?.length > 0 && (
              <>
                <div style={{ marginTop: 12, marginBottom: 6, fontSize: 10, color: 'var(--sa-text-dim)', letterSpacing: 1, textTransform: 'uppercase' }}>
                  By model / index
                </div>
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead>
                      <tr><th>Model</th><th>Index</th><th>Count</th></tr>
                    </thead>
                    <tbody>
                      {embeddings.byModel.map((row, i) => (
                        <tr key={i}>
                          <td>{row.model}</td>
                          <td style={{ color: 'var(--sa-accent)' }}>wines_{row.indexVersion}</td>
                          <td>{num(row.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Chat event log (errors / fallbacks) */}
      {data.chatEventLog?.length > 0 && (
        <div className="sa-panel" style={{ marginBottom: 16 }}>
          <div className="sa-panel-header">
            <span className="sa-panel-title">Chat Error Log</span>
            <span style={{ fontSize: 11, color: 'var(--sa-text-dim)' }}>Last {data.chatEventLog.length} events (in-memory, resets on restart)</span>
          </div>
          <div className="sa-panel-body">
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Phase</th>
                    <th>Primary model</th>
                    <th>Status</th>
                    <th>Error</th>
                    <th>Fallback</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {data.chatEventLog.map((e, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap' }}>{ago(e.timestamp)}</td>
                      <td>{e.phase}</td>
                      <td style={{ fontSize: 11 }}>{e.primaryModel}</td>
                      <td className={e.status >= 500 ? 'danger' : ''}>{e.status || '—'}</td>
                      <td style={{ fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.errorMessage || ''}>
                        {e.errorType || e.errorMessage || '—'}
                      </td>
                      <td style={{ fontSize: 11 }}>
                        {e.fallbackAttempted ? e.fallbackModel : <span style={{ color: 'var(--sa-text-dim)' }}>none</span>}
                      </td>
                      <td>
                        {e.fallbackResult === 'ok' && <span className="accent">OK</span>}
                        {e.fallbackResult === 'failed' && <span className="danger">FAILED</span>}
                        {!e.fallbackAttempted && <span style={{ color: 'var(--sa-text-dim)' }}>no fallback</span>}
                        {e.fallbackAttempted && !e.fallbackResult && <span style={{ color: 'var(--sa-text-dim)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      <ChatModelPanel currentModel={config.chatModel} currentFallback={config.chatModelFallback || null} apiFetch={apiFetch} />
      <SystemPromptPanel prompt={config.chatSystemPrompt || ''} apiFetch={apiFetch} />
      <ChatLimitsPanel limits={config.chatDailyLimits || {}} apiFetch={apiFetch} />
      <ChatUsagePanel />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab: Deleted Cellars (restore)
// ─────────────────────────────────────────────────────────────────────────────

function daysUntilPurge(deletedAt) {
  const purgeAt = new Date(deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (1000 * 60 * 60 * 24)));
}

function TabCellars() {
  const { apiFetch } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState({});
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

  async function restore(cellar) {
    setRestoring(prev => ({ ...prev, [cellar._id]: true }));
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/cellars/${cellar._id}/restore`, { method: 'POST' });
      const body = await res.json();
      if (res.ok) {
        setNotices(prev => [...prev, `Restored as "${body.cellar.name}"`]);
        setData(prev => prev ? { ...prev, cellars: prev.cellars.filter(c => c._id !== cellar._id), total: prev.total - 1 } : prev);
      } else {
        setError(body.error || 'Failed to restore');
      }
    } catch {
      setError('Network error');
    } finally {
      setRestoring(prev => ({ ...prev, [cellar._id]: false }));
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
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.cellars || []).map(c => {
                    const days = daysUntilPurge(c.deletedAt);
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
                          <button
                            className="sa-btn"
                            disabled={restoring[c._id]}
                            onClick={() => restore(c)}
                          >
                            {restoring[c._id] ? 'Restoring…' : 'Restore'}
                          </button>
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

const TABS = [
  { id: 'overview',   label: 'Overview' },
  { id: 'services',   label: 'Services' },
  { id: 'database',   label: 'Database' },
  { id: 'settings',   label: 'Settings' },
  { id: 'ai',         label: 'AI & Embeddings' },
  { id: 'users',      label: 'Users' },
  { id: 'audit',      label: 'Audit Log' },
  { id: 'cellars',    label: 'Deleted Cellars' },
];

export default function SuperAdmin() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [refreshKey, setRefreshKey] = useState(0);
  const timerRef = useRef(null);

  // Guard: if not super admin, redirect
  useEffect(() => {
    if (user && !user.isSuperAdmin) {
      navigate('/cellars', { replace: true });
    }
  }, [user, navigate]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => {
        setRefreshKey(k => k + 1);
        setLastRefresh(new Date());
      }, 30000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [autoRefresh]);

  const manualRefresh = () => {
    setRefreshKey(k => k + 1);
    setLastRefresh(new Date());
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  if (!user?.isSuperAdmin) return null;

  return (
    <div className="sa-root">
      {/* Top bar */}
      <div className="sa-topbar">
        <div className="sa-topbar-title">
          CELLARION SYSTEM MONITOR
          <span>v{process.env.REACT_APP_VERSION || '—'} · {user.email}</span>
        </div>
        <div className="sa-topbar-meta">
          <span>Last refresh: {lastRefresh.toLocaleTimeString()}</span>
          <button
            className={`sa-btn ${autoRefresh ? 'active' : ''}`}
            onClick={() => setAutoRefresh(a => !a)}
          >
            {autoRefresh ? 'Auto: ON' : 'Auto: OFF'}
          </button>
          <button className="sa-btn" onClick={manualRefresh}>Refresh</button>
          <button className="sa-btn" onClick={() => navigate('/cellars')}>Back to App</button>
          <button className="sa-btn sa-btn-danger" onClick={handleLogout}>Logout</button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="sa-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`sa-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content — refreshKey forces remount on manual/auto refresh */}
      <div className="sa-content" key={`${tab}-${refreshKey}`}>
        {tab === 'overview'   && <TabOverview />}
        {tab === 'services'   && <TabServices />}
        {tab === 'database'   && <TabDatabase />}
        {tab === 'settings'   && <TabSettings />}
        {tab === 'ai'         && <TabAI />}
        {tab === 'users'      && <TabUsers />}
        {tab === 'audit'      && <TabAudit />}
        {tab === 'cellars'    && <TabCellars />}
      </div>

      {/* Footer */}
      <div className="sa-footer">
        <span>Super Admin — {user.email}</span>
        <span>Cellarion System Monitor · Access is logged</span>
      </div>
    </div>
  );
}
