import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getDrinkStatus, formatDrinkDate } from '../utils/drinkStatus';
import './DrinkAlerts.css';

const STATUS_CONFIG = {
  overdue: { className: 'overdue' },
  soon:    { className: 'soon' },
  inWindow:{ className: 'inWindow' },
  notReady:{ className: 'notReady' },
};

function DrinkAlerts() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch } = useAuth();
  const [cellar, setCellar] = useState(null);
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchBottles();
  }, [id, apiFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchBottles = async () => {
    try {
      const res = await apiFetch(`/api/cellars/${id}`);
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

  if (loading) return <div className="loading">{t('drinkAlerts.loadingAlerts')}</div>;
  if (error) return <div className="alert alert-error">{error}</div>;

  const totalAlerts = (grouped.overdue?.length || 0) + (grouped.soon?.length || 0);

  return (
    <div className="drink-alerts-page">
      <div className="alerts-header">
        <Link to={`/cellars/${id}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          {t('drinkAlerts.backTo', { cellarName: cellar?.name })}
        </Link>
        <h1 style={cellar?.userColor ? { borderLeft: `4px solid ${cellar.userColor}`, paddingLeft: '0.75rem' } : {}}>
          {t('drinkAlerts.title')}
        </h1>
        <p className="page-subtitle">
          {totalAlerts > 0
            ? t('drinkAlerts.needsAttention', { count: totalAlerts })
            : t('drinkAlerts.allOnTrack')}
        </p>
      </div>

      {/* Summary pill row */}
      <div className="alert-summary-row">
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
          const count = grouped[key]?.length || 0;
          return (
            <div key={key} className={`alert-summary-pill ${cfg.className} ${count === 0 ? 'empty' : ''}`}>
              <span className="pill-count">{count}</span>
              <span className="pill-label">{t(`drinkAlerts.${key}Label`)}</span>
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
              <h2>{t(`drinkAlerts.${key}Label`)} <span className="section-count">({items.length})</span></h2>
              <p>{t(`drinkAlerts.${key}Desc`)}</p>
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
            <h2>{t('drinkAlerts.noDatesLabel')} <span className="section-count">({grouped.noDates.length})</span></h2>
            <p>{t('drinkAlerts.noDatesDesc')}</p>
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
  const { t } = useTranslation();
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
          <h3>{wine?.name || t('common.unknownWine')}</h3>
          <p className="alert-producer">{wine?.producer}</p>
          <p className="alert-vintage">{t('drinkAlerts.vintageLabel')} {bottle.vintage}</p>
        </div>
      </div>
      <div className="alert-bottle-window">
        {(bottle.drinkFrom || bottle.drinkBefore) ? (
          <>
            {bottle.drinkFrom && <span>{t('drinkAlerts.fromLabel')}{formatDrinkDate(bottle.drinkFrom)}</span>}
            {bottle.drinkFrom && bottle.drinkBefore && <span className="arrow"> → </span>}
            {bottle.drinkBefore && <span>{t('drinkAlerts.beforeLabel')}{formatDrinkDate(bottle.drinkBefore)}</span>}
          </>
        ) : (
          <span className="no-dates-text">{t('drinkAlerts.noDatesText')}</span>
        )}
        {status && (
          <span className={`drink-status-pill ${status.status}`}>{status.label}</span>
        )}
      </div>
    </div>
  );
}

export default DrinkAlerts;
