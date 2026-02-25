import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './CellarHistory.css';

const REASON_CONFIG = {
  drank:  { label: 'Drank',   icon: '🍷', className: 'drank' },
  gifted: { label: 'Gifted',  icon: '🎁', className: 'gifted' },
  sold:   { label: 'Sold',    icon: '💰', className: 'sold' },
  other:  { label: 'Other',   icon: '📦', className: 'other' },
};

function CellarHistory() {
  const { id } = useParams();
  const { token } = useAuth();
  const [cellar, setCellar] = useState(null);
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetchHistory();
  }, [id, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchHistory = async () => {
    try {
      const res = await fetch(`/api/cellars/${id}/history`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to load history'); return; }

      setCellar(data.cellar);
      setTotal(data.bottles.length);

      // Group by reason
      const groups = { drank: [], gifted: [], sold: [], other: [] };
      (data.bottles || []).forEach(bottle => {
        const reason = bottle.consumedReason || bottle.status;
        if (groups[reason]) groups[reason].push(bottle);
        else groups.other.push(bottle);
      });
      setGrouped(groups);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="loading">Loading history...</div>;
  if (error) return <div className="alert alert-error">{error}</div>;

  return (
    <div className="cellar-history-page">
      <div className="page-header">
        <div>
          <Link to={`/cellars/${id}`} className="back-link">← Back to {cellar?.name}</Link>
          <h1 style={cellar?.userColor ? { borderLeft: `4px solid ${cellar.userColor}`, paddingLeft: '0.75rem' } : {}}>
            Bottle History
          </h1>
          <p className="page-subtitle">
            {total === 0
              ? 'No bottles have been removed from this cellar yet'
              : `${total} bottle${total !== 1 ? 's' : ''} in history`}
          </p>
        </div>
      </div>

      {/* Summary row */}
      {total > 0 && (
        <div className="history-summary-row">
          {Object.entries(REASON_CONFIG).map(([key, cfg]) => {
            const count = grouped[key]?.length || 0;
            return (
              <div key={key} className={`history-summary-pill ${cfg.className} ${count === 0 ? 'empty' : ''}`}>
                <span>{cfg.icon}</span>
                <span className="pill-count">{count}</span>
                <span>{cfg.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {total === 0 && (
        <div className="empty-state">
          <p>When you mark a bottle as consumed, gifted, or sold it will appear here.</p>
          <Link to={`/cellars/${id}`} className="btn btn-primary">Back to Cellar</Link>
        </div>
      )}

      {Object.entries(REASON_CONFIG).map(([key, cfg]) => {
        const items = grouped[key] || [];
        if (items.length === 0) return null;
        return (
          <section key={key} className={`history-section ${cfg.className}`}>
            <div className="history-section-header">
              <span className="history-section-icon">{cfg.icon}</span>
              <h2>{cfg.label} <span className="section-count">({items.length})</span></h2>
            </div>
            <div className="history-bottles">
              {items.map(bottle => (
                <HistoryBottleCard key={bottle._id} bottle={bottle} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function HistoryBottleCard({ bottle }) {
  const wine = bottle.wineDefinition;
  const consumedDate = bottle.consumedAt
    ? new Date(bottle.consumedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  return (
    <div className={`history-bottle-card ${bottle.consumedReason || bottle.status}`}>
      <div className="history-bottle-main">
        {wine?.image && (
          <img
            src={wine.image}
            alt={wine.name}
            className="history-bottle-image"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        )}
        <div className="history-bottle-info">
          <h3>{wine?.name || 'Unknown Wine'}</h3>
          <p className="history-producer">{wine?.producer}</p>
          <div className="history-meta">
            <span>Vintage: {bottle.vintage}</span>
            {consumedDate && <span>· {consumedDate}</span>}
            {bottle.price && <span>· Paid: {bottle.price} {bottle.currency}</span>}
          </div>
        </div>
      </div>

      {/* Consumption details */}
      <div className="history-bottle-details">
        {bottle.consumedRating && (
          <div className="history-rating">
            {'⭐'.repeat(bottle.consumedRating)}
            <span className="rating-label">at consumption</span>
          </div>
        )}
        {bottle.consumedNote && (
          <p className="history-note">"{bottle.consumedNote}"</p>
        )}
      </div>
    </div>
  );
}

export default CellarHistory;
