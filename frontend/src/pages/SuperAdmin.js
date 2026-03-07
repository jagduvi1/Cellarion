import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
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

// ─────────────────────────────────────────────────────────────────────────────
// Tab: AI & Embeddings
// ─────────────────────────────────────────────────────────────────────────────

function TabAI() {
  const { data, loading, error, reload } = useApi('/api/superadmin/ai');

  if (loading) return <div className="sa-loading">Loading AI pipeline stats...</div>;
  if (error)   return <div className="sa-error">Error: {error}</div>;
  if (!data)   return null;

  const { configured, config, job, collection, embeddings } = data;

  const jobPct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const jobStatusColor =
    job.status === 'running'  ? 'warn' :
    job.status === 'done'     ? 'accent' :
    job.status === 'error'    ? 'danger' : '';

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
          <div className="sa-panel-header"><span className="sa-panel-title">Embedding Job</span></div>
          <div className="sa-panel-body">
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
    </>
  );
}

const TABS = [
  { id: 'overview',   label: 'Overview' },
  { id: 'services',   label: 'Services' },
  { id: 'database',   label: 'Database' },
  { id: 'ai',         label: 'AI & Embeddings' },
  { id: 'users',      label: 'Users' },
  { id: 'audit',      label: 'Audit Log' },
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
        {tab === 'ai'         && <TabAI />}
        {tab === 'users'      && <TabUsers />}
        {tab === 'audit'      && <TabAudit />}
      </div>

      {/* Footer */}
      <div className="sa-footer">
        <span>Super Admin — {user.email}</span>
        <span>Cellarion System Monitor · Access is logged</span>
      </div>
    </div>
  );
}
