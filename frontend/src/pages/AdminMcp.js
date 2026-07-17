import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetMcpUsage, adminSetMcpSwitches } from '../api/admin';
import './AdminMcp.css';

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function StatCard({ label, value, sublabel }) {
  return (
    <div className="admin-mcp-card">
      <div className="admin-mcp-card-value">{value ?? '—'}</div>
      <div className="admin-mcp-card-label">{label}</div>
      {sublabel && <div className="admin-mcp-card-sub">{sublabel}</div>}
    </div>
  );
}

// Collapse the per-surface daily rows into one row per day with both surfaces.
function byDay(daily) {
  const map = new Map();
  for (const d of daily) {
    const key = String(d.day).slice(0, 10);
    if (!map.has(key)) map.set(key, { day: key, personal: 0, public: 0, errors: 0 });
    const row = map.get(key);
    row[d.surface] += d.calls;
    row.errors += d.errors;
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

function AdminMcp() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminGetMcpUsage(apiFetch, days));
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, days]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (field) => {
    if (!data || saving) return;
    const next = { ...data.mcpConfig, [field]: data.mcpConfig[field] === 0 ? 1 : 0 };
    setSaving(true);
    setError(null);
    try {
      await adminSetMcpSwitches(apiFetch, next);
      setData((d) => ({ ...d, mcpConfig: next }));
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const rows = data ? byDay(data.daily) : [];
  const maxDay = Math.max(1, ...rows.map((r) => r.personal + r.public));
  const totals = rows.reduce((acc, r) => ({
    calls: acc.calls + r.personal + r.public,
    errors: acc.errors + r.errors,
  }), { calls: 0, errors: 0 });
  const conn = data?.connections;

  return (
    <div className="admin-mcp-page">
      <div className="admin-mcp-header">
        <h1>{t('adminMcp.title')}</h1>
        <div className="admin-mcp-range">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className={`admin-mcp-range-btn ${days === d ? 'active' : ''}`}
              onClick={() => setDays(d)}
            >
              {t('adminMcp.lastNDays', { count: d })}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="admin-mcp-error">{error}</div>}
      {loading && !data && <div className="admin-mcp-loading">{t('common.loading')}</div>}

      {data && (
        <>
          <div className="admin-mcp-switches">
            <label className={`admin-mcp-switch ${saving ? 'saving' : ''}`}>
              <input
                type="checkbox"
                checked={data.mcpConfig.enabled === 1}
                disabled={saving}
                onChange={() => toggle('enabled')}
              />
              <div>
                <div className="admin-mcp-switch-name">{t('adminMcp.switchAll')}</div>
                <div className="admin-mcp-switch-desc">{t('adminMcp.switchAllDesc')}</div>
              </div>
            </label>
            <label className={`admin-mcp-switch ${saving ? 'saving' : ''} ${data.mcpConfig.enabled === 0 ? 'overridden' : ''}`}>
              <input
                type="checkbox"
                checked={data.mcpConfig.publicEnabled === 1}
                disabled={saving || data.mcpConfig.enabled === 0}
                onChange={() => toggle('publicEnabled')}
              />
              <div>
                <div className="admin-mcp-switch-name">{t('adminMcp.switchPublic')}</div>
                <div className="admin-mcp-switch-desc">{t('adminMcp.switchPublicDesc')}</div>
              </div>
            </label>
          </div>

          <div className="admin-mcp-cards">
            <StatCard label={t('adminMcp.calls')} value={fmt(totals.calls)} sublabel={t('adminMcp.lastNDays', { count: days })} />
            <StatCard label={t('adminMcp.errors')} value={fmt(totals.errors)} sublabel={t('adminMcp.lastNDays', { count: days })} />
            <StatCard
              label={t('adminMcp.connections')}
              value={fmt((conn?.bearer.total || 0) + (conn?.oauth.total || 0))}
              sublabel={t('adminMcp.connectionsSplit', {
                oauth: fmt(conn?.oauth.total || 0),
                bearer: fmt(conn?.bearer.total || 0),
              })}
            />
            <StatCard
              label={t('adminMcp.activeConnections')}
              value={fmt((conn?.bearer.activeLast7d || 0) + (conn?.oauth.activeLast7d || 0))}
              sublabel={t('adminMcp.last7Days')}
            />
            <StatCard label={t('adminMcp.writes')} value={fmt(data.writesLast7d)} sublabel={t('adminMcp.last7Days')} />
          </div>

          <div className="admin-mcp-panels">
            <div className="admin-mcp-panel">
              <h3>{t('adminMcp.dailyActivity')}</h3>
              {rows.length === 0 ? (
                <p className="admin-mcp-empty">{t('adminMcp.noUsage')}</p>
              ) : (
                <table className="admin-mcp-table">
                  <thead>
                    <tr>
                      <th>{t('adminMcp.day')}</th>
                      <th>{t('adminMcp.personal')}</th>
                      <th>{t('adminMcp.public')}</th>
                      <th>{t('adminMcp.errors')}</th>
                      <th className="admin-mcp-bar-col" aria-hidden="true"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.day}>
                        <td>{r.day}</td>
                        <td>{fmt(r.personal)}</td>
                        <td>{fmt(r.public)}</td>
                        <td>{r.errors > 0 ? fmt(r.errors) : '—'}</td>
                        <td className="admin-mcp-bar-col">
                          <div className="admin-mcp-bar" style={{ width: `${Math.round(((r.personal + r.public) / maxDay) * 100)}%` }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="admin-mcp-panel">
              <h3>{t('adminMcp.topTools')}</h3>
              {data.topTools.length === 0 ? (
                <p className="admin-mcp-empty">{t('adminMcp.noUsage')}</p>
              ) : (
                <table className="admin-mcp-table">
                  <thead>
                    <tr>
                      <th>{t('adminMcp.tool')}</th>
                      <th>{t('adminMcp.surface')}</th>
                      <th>{t('adminMcp.calls')}</th>
                      <th>{t('adminMcp.errors')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topTools.map((tool) => (
                      <tr key={`${tool.surface}:${tool.name}`}>
                        <td className="admin-mcp-tool-name">{tool.name}</td>
                        <td>{t(tool.surface === 'public' ? 'adminMcp.public' : 'adminMcp.personal')}</td>
                        <td>{fmt(tool.calls)}</td>
                        <td>{tool.errors > 0 ? fmt(tool.errors) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default AdminMcp;
