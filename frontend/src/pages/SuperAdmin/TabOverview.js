import { num, ago, PlanBadge, RoleBadge, Sparkline, useApi } from './helpers';

export default function TabOverview() {
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
        {/* Users by supporter tier */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">Users by Tier</span></div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              {['free', 'supporter', 'patron'].map(p => (
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
