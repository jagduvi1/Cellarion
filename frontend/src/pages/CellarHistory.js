import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import RatingDisplay from '../components/RatingDisplay';
import './CellarHistory.css';

const REASON_CONFIG = {
  drank:  { icon: '🍷', className: 'drank' },
  gifted: { icon: '🎁', className: 'gifted' },
  sold:   { icon: '💰', className: 'sold' },
  other:  { icon: '📦', className: 'other' },
};

function CellarHistory() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user } = useAuth();
  const [cellar, setCellar] = useState(null);
  const [grouped, setGrouped] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetchHistory();
  }, [id, apiFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchHistory = async () => {
    try {
      const res = await apiFetch(`/api/cellars/${id}/history`);
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

  if (loading) return <div className="loading">{t('history.loadingHistory')}</div>;
  if (error) return <div className="alert alert-error">{error}</div>;

  const REASON_LABEL_KEYS = {
    drank:  'history.reasonDrank',
    gifted: 'history.reasonGifted',
    sold:   'history.reasonSold',
    other:  'history.reasonOther',
  };

  return (
    <div className="cellar-history-page">
      <div className="history-header">
        <Link to={`/cellars/${id}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          {t('history.backTo', { cellarName: cellar?.name })}
        </Link>
        <h1 style={cellar?.userColor ? { borderLeft: `4px solid ${cellar.userColor}`, paddingLeft: '0.75rem' } : {}}>
          {t('history.title')}
        </h1>
        <p className="page-subtitle">
          {total === 0
            ? t('history.noHistory')
            : t('history.bottleCount', { count: total })}
        </p>
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
                <span>{t(REASON_LABEL_KEYS[key])}</span>
              </div>
            );
          })}
        </div>
      )}

      {total === 0 && (
        <div className="empty-state">
          <p>{t('history.emptyHistoryHint')}</p>
          <Link to={`/cellars/${id}`} className="btn btn-primary">{t('history.backToCellarBtn')}</Link>
        </div>
      )}

      {Object.entries(REASON_CONFIG).map(([key, cfg]) => {
        const items = grouped[key] || [];
        if (items.length === 0) return null;
        return (
          <section key={key} className={`history-section ${cfg.className}`}>
            <div className="history-section-header">
              <span className="history-section-icon">{cfg.icon}</span>
              <h2>{t(REASON_LABEL_KEYS[key])} <span className="section-count">({items.length})</span></h2>
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
  const { t } = useTranslation();
  const { user } = useAuth();
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
          <h3>{wine?.name || t('common.unknownWine')}</h3>
          <p className="history-producer">{wine?.producer}</p>
          <div className="history-meta">
            <span>{t('history.vintageLabel')} {bottle.vintage}</span>
            {consumedDate && <span>· {consumedDate}</span>}
            {bottle.price && <span>· {t('history.paidLabel')} {bottle.price} {bottle.currency}</span>}
          </div>
        </div>
      </div>

      {/* Consumption details */}
      <div className="history-bottle-details">
        {bottle.consumedRating && (
          <div className="history-rating">
            <RatingDisplay value={bottle.consumedRating} scale={bottle.consumedRatingScale || '5'} preferredScale={user?.preferences?.ratingScale} />
            <span className="rating-label">{t('history.atConsumption')}</span>
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
