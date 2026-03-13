import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function num(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

export function ago(dateStr) {
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

export function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toISOString().replace('T', ' ').slice(0, 19);
}

export function actionClass(action) {
  if (!action) return '';
  if (action.startsWith('auth')) return 'action-auth';
  if (action.startsWith('superadmin')) return 'action-superadmin';
  if (action.startsWith('admin')) return 'action-admin';
  if (action.startsWith('bottle')) return 'action-bottle';
  if (action.startsWith('cellar')) return 'action-cellar';
  if (action.startsWith('system')) return 'action-system';
  return '';
}

export function StatusDot({ status }) {
  const cls =
    status === 'ok' || status === 'available' ? 'ok' :
    status === 'error' ? 'error' :
    status === 'not_configured' ? 'off' : 'warn';
  return <span className={`sa-service-dot ${cls}`} />;
}

export function BarFill({ pct, warn = 70, danger = 90 }) {
  const cls = pct >= danger ? 'danger' : pct >= warn ? 'warn' : '';
  return (
    <div className="sa-bar-wrap">
      <div className="sa-bar-track">
        <div className="sa-bar-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

export function PlanBadge({ plan }) {
  return <span className={`sa-badge ${plan || 'free'}`}>{plan || 'free'}</span>;
}

export function RoleBadge({ role }) {
  return <span className={`sa-badge ${role}`}>{role}</span>;
}

export function Sparkline({ data }) {
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

export function useApi(path, { skip = false } = {}) {
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
