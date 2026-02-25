import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './CellarAudit.css';

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

const ACTION_LABELS = {
  'bottle.add':          'Added bottle',
  'bottle.update':       'Updated bottle',
  'bottle.consume':      'Consumed bottle',
  'bottle.delete':       'Deleted bottle',
  'cellar.delete':       'Deleted cellar',
  'cellar.share.add':    'Shared cellar',
  'cellar.share.update': 'Changed share role',
  'cellar.share.remove': 'Removed share'
};

const ACTION_ICONS = {
  'bottle.add':          '➕',
  'bottle.update':       '✏️',
  'bottle.consume':      '🍷',
  'bottle.delete':       '🗑️',
  'cellar.delete':       '🗑️',
  'cellar.share.add':    '🔗',
  'cellar.share.update': '🔄',
  'cellar.share.remove': '✖️'
};

function fmtVal(val) {
  if (val === null || val === undefined || val === '') return '—';
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
    try {
      return new Date(val).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { /* fall through */ }
  }
  return String(val);
}

function formatDetail(action, detail) {
  if (!detail || Object.keys(detail).length === 0) return null;
  if (action === 'bottle.add' && detail.wineName) {
    return `${detail.wineName}${detail.vintage ? ` · ${detail.vintage}` : ''}`;
  }
  if (action === 'bottle.consume' && detail.reason) {
    return detail.reason;
  }
  if (action === 'cellar.share.add') {
    return `${detail.sharedWith} as ${detail.role}`;
  }
  if (action === 'cellar.share.update') {
    return `Role changed: ${detail.from} → ${detail.to}`;
  }
  if (action === 'bottle.update' && detail.changes) {
    const entries = Object.entries(detail.changes);
    if (entries.length === 0) return null;
    return entries
      .map(([field, { from, to }]) => `${field}: ${fmtVal(from)} → ${fmtVal(to)}`)
      .join(' · ');
  }
  return null;
}

function CellarAudit() {
  const { id } = useParams();
  const { token } = useAuth();
  const [logs, setLogs] = useState([]);
  const [cellarName, setCellarName] = useState('');
  const [cellarColor, setCellarColor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const auth = { 'Authorization': `Bearer ${token}` };

    // Fetch cellar + audit in parallel
    Promise.all([
      fetch(`/api/cellars/${id}`, { headers: auth }).then(r => r.json()),
      fetch(`/api/cellars/${id}/audit`, { headers: auth }).then(r => r.json())
    ]).then(([cellarData, auditData]) => {
      if (cellarData.cellar) {
        setCellarName(cellarData.cellar.name);
        setCellarColor(cellarData.cellar.userColor || null);
      }
      if (auditData.logs)    setLogs(auditData.logs);
      if (auditData.error)   setError(auditData.error);
    }).catch(() => setError('Network error'))
      .finally(() => setLoading(false));
  }, [id, token]);

  const h1Style = cellarColor
    ? { borderLeft: `4px solid ${cellarColor}`, paddingLeft: '0.75rem' }
    : {};

  return (
    <div className="cellar-audit-page">
      <div className="page-header">
        <div>
          <Link to={`/cellars/${id}`} className="back-link">← Back to Cellar</Link>
          <h1 style={h1Style}>{cellarName ? `${cellarName} — Audit Log` : 'Audit Log'}</h1>
          <p className="cellar-description">Last 100 events for this cellar</p>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading audit log…</div>
      ) : logs.length === 0 ? (
        <div className="empty-state"><p>No audit events yet for this cellar.</p></div>
      ) : (
        <div className="cellar-audit-list">
          {logs.map(log => {
            const detail = formatDetail(log.action, log.detail);
            return (
              <div key={log._id} className="cellar-audit-item">
                <div className="cellar-audit-icon">
                  {ACTION_ICONS[log.action] || '•'}
                </div>
                <div className="cellar-audit-body">
                  <div className="cellar-audit-primary">
                    <span className="cellar-audit-label">
                      {ACTION_LABELS[log.action] || log.action}
                    </span>
                    {detail && (
                      <span className="cellar-audit-detail">— {detail}</span>
                    )}
                  </div>
                  <div className="cellar-audit-meta">
                    <span className="cellar-audit-user">
                      {log.actor?.userId?.username || 'anonymous'}
                    </span>
                    <span className="cellar-audit-sep">·</span>
                    <span className="cellar-audit-time">
                      {formatTimestamp(log.timestamp)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default CellarAudit;
