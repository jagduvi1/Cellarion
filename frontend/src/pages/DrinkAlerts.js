import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getDrinkStatus, formatDrinkDate } from '../utils/drinkStatus';
import './DrinkAlerts.css';

const STATUS_CONFIG = {
  overdue: { label: 'Overdue', description: 'Past the drink-before date — open these soon!', className: 'overdue' },
  soon:    { label: 'Drink Soon', description: 'Within 90 days of the drink-before date', className: 'soon' },
  inWindow:{ label: 'In Drinking Window', description: 'Currently at their best', className: 'inWindow' },
  notReady:{ label: 'Not Ready Yet', description: 'Still developing — hold off for now', className: 'notReady' },
};

function DrinkAlerts() {
  const { id } = useParams();
  const { token } = useAuth();
  const [cellar, setCellar] = useState(null);
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchBottles();
  }, [id, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchBottles = async () => {
    try {
      const res = await fetch(`/api/cellars/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to load cellar'); return; }

      setCellar(data.cellar);

      // Group bottles by drink status; bottles without dates go into 'noDates'
      const groups = { overdue: [], soon: [], inWindow: [], notReady: [], noDates: [] };
      (data.bottles.items || []).forEach(bottle => {
        const status = getDrinkStatus(bottle);
        if (!status) { groups.noDates.push({ bottle, status: null }); return; }
        groups[status.status].push({ bottle, status });
      });

      // Sort each group by urgency: overdue most overdue first, others soonest expiry first
      groups.overdue.sort((a, b) => a.status.daysLeft - b.status.daysLeft);
      groups.soon.sort((a, b) => a.status.daysLeft - b.status.daysLeft);
      groups.inWindow.sort((a, b) => {
        if (a.status.daysLeft === null) return 1;
        if (b.status.daysLeft === null) return -1;
        return a.status.daysLeft - b.status.daysLeft;
      });
      groups.notReady.sort((a, b) => a.status.daysLeft - b.status.daysLeft);

      setGrouped(groups);
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="loading">Loading drink alerts...</div>;
  if (error) return <div className="alert alert-error">{error}</div>;

  const totalAlerts = (grouped.overdue?.length || 0) + (grouped.soon?.length || 0);

  return (
    <div className="drink-alerts-page">
      <div className="page-header">
        <div>
          <Link to={`/cellars/${id}`} className="back-link">← Back to {cellar?.name}</Link>
          <h1 style={cellar?.userColor ? { borderLeft: `4px solid ${cellar.userColor}`, paddingLeft: '0.75rem' } : {}}>
            Drink Alerts
          </h1>
          <p className="page-subtitle">
            {totalAlerts > 0
              ? `${totalAlerts} bottle${totalAlerts > 1 ? 's' : ''} need${totalAlerts === 1 ? 's' : ''} attention`
              : 'All bottles are on track'}
          </p>
        </div>
      </div>

      {/* Summary pill row */}
      <div className="alert-summary-row">
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
          const count = grouped[key]?.length || 0;
          return (
            <div key={key} className={`alert-summary-pill ${cfg.className} ${count === 0 ? 'empty' : ''}`}>
              <span className="pill-count">{count}</span>
              <span className="pill-label">{cfg.label}</span>
            </div>
          );
        })}
      </div>

      {/* Sections in priority order */}
      {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
        const items = grouped[key] || [];
        if (items.length === 0) return null;
        return (
          <section key={key} className={`alert-section ${cfg.className}`}>
            <div className="alert-section-header">
              <h2>{cfg.label} <span className="section-count">({items.length})</span></h2>
              <p>{cfg.description}</p>
            </div>
            <div className="alert-bottles">
              {items.map(({ bottle, status }) => (
                <BottleAlertCard key={bottle._id} bottle={bottle} status={status} />
              ))}
            </div>
          </section>
        );
      })}

      {/* Bottles with no drink window set */}
      {grouped.noDates?.length > 0 && (
        <section className="alert-section noDates">
          <div className="alert-section-header">
            <h2>No Drink Window Set <span className="section-count">({grouped.noDates.length})</span></h2>
            <p>These bottles have no drink window. Open each cellar bottle to set one.</p>
          </div>
          <div className="alert-bottles">
            {grouped.noDates.map(({ bottle }) => (
              <BottleAlertCard key={bottle._id} bottle={bottle} status={null} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function BottleAlertCard({ bottle, status }) {
  const wine = bottle.wineDefinition;
  return (
    <div className={`alert-bottle-card ${status ? status.status : 'noDates'}`}>
      <div className="alert-bottle-main">
        {wine?.image && (
          <img
            src={wine.image}
            alt={wine.name}
            className="alert-bottle-image"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        )}
        <div className="alert-bottle-info">
          <h3>{wine?.name || 'Unknown Wine'}</h3>
          <p className="alert-producer">{wine?.producer}</p>
          <p className="alert-vintage">Vintage: {bottle.vintage}</p>
        </div>
      </div>
      <div className="alert-bottle-window">
        {(bottle.drinkFrom || bottle.drinkBefore) ? (
          <>
            {bottle.drinkFrom && <span>From {formatDrinkDate(bottle.drinkFrom)}</span>}
            {bottle.drinkFrom && bottle.drinkBefore && <span className="arrow"> → </span>}
            {bottle.drinkBefore && <span>Before {formatDrinkDate(bottle.drinkBefore)}</span>}
          </>
        ) : (
          <span className="no-dates-text">No dates set</span>
        )}
        {status && (
          <span className={`drink-status-pill ${status.status}`}>{status.label}</span>
        )}
      </div>
    </div>
  );
}

export default DrinkAlerts;
