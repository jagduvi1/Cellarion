import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import TabOverview from './TabOverview';
import TabServices from './TabServices';
import TabDatabase from './TabDatabase';
import TabUsers from './TabUsers';
import TabAudit from './TabAudit';
import TabSettings from './TabSettings';
import TabAI from './TabAI';
import TabCellars from './TabCellars';
import TabImport from './TabImport';
import '../SuperAdmin.css';

const TABS = [
  { id: 'overview',   label: 'Overview' },
  { id: 'services',   label: 'Services' },
  { id: 'database',   label: 'Database' },
  { id: 'users',      label: 'Users' },
  { id: 'audit',      label: 'Audit Log' },
  { id: 'cellars',    label: 'Deleted Cellars' },
  { id: 'import',     label: 'Import Wines' },
  { id: 'ai',         label: 'AI & Embeddings' },
  { id: 'settings',   label: 'Settings' },
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
        {tab === 'users'      && <TabUsers />}
        {tab === 'audit'      && <TabAudit />}
        {tab === 'cellars'    && <TabCellars />}
        {tab === 'import'     && <TabImport />}
        {tab === 'ai'         && <TabAI />}
        {tab === 'settings'   && <TabSettings />}
      </div>

      {/* Footer */}
      <div className="sa-footer">
        <span>Super Admin — {user.email}</span>
        <span>Cellarion System Monitor · Access is logged</span>
      </div>
    </div>
  );
}
