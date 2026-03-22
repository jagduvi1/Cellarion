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
  const [search, setSearch] = useState('');

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
          {t('history.backTo', { cellarName: cellar?.name || '…' })}
        </Link>
        {loading ? (
          <div className="skeleton-h1" />
        ) : (
          <>
            <h1 className={cellar?.userColor ? 'cellar-accent-border' : ''} style={cellar?.userColor ? { '--cellar-color': cellar.userColor } : undefined}>
              {t('history.title')}
            </h1>
            <p className="page-subtitle">
              {total === 0
                ? t('history.noHistory')
                : t('history.bottleCount', { count: total })}
            </p>
          </>
        )}
      </div>

      {loading ? (
        <div className="loading">{t('history.loadingHistory')}</div>
      ) : <>

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

      {/* Search */}
      {total > 0 && (
        <div className="history-search">
          <svg className="history-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            className="search-input"
            placeholder={t('history.searchPlaceholder', 'Search by name, producer, or vintage…')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="history-search-clear" onClick={() => setSearch('')} aria-label={t('common.clear', 'Clear')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
      )}

      {total === 0 && (
        <div className="empty-state">
          <p>{t('history.emptyHistoryHint')}</p>
          <Link to={`/cellars/${id}`} className="btn btn-primary">{t('history.backToCellarBtn')}</Link>
        </div>
      )}

      {(() => {
        const q = search.toLowerCase().trim();
        const matchesSearch = (bottle) => {
          if (!q) return true;
          const wine = bottle.wineDefinition;
          const name = (wine?.name || '').toLowerCase();
          const producer = (wine?.producer || '').toLowerCase();
          const vintage = String(bottle.vintage || '').toLowerCase();
          return name.includes(q) || producer.includes(q) || vintage.includes(q);
        };

        let anyVisible = false;
        const sections = Object.entries(REASON_CONFIG).map(([key, cfg]) => {
          const items = (grouped[key] || []).filter(matchesSearch);
          if (items.length === 0) return null;
          anyVisible = true;
          return (
            <section key={key} className={`history-section ${cfg.className}`}>
              <div className="history-section-header">
                <span className="history-section-icon">{cfg.icon}</span>
                <h2>{t(REASON_LABEL_KEYS[key])} <span className="section-count">({items.length})</span></h2>
              </div>
              <div className="history-bottles">
                {items.map(bottle => (
                  <HistoryBottleCard key={bottle._id} bottle={bottle} cellarId={id} />
                ))}
              </div>
            </section>
          );
        });

        if (q && !anyVisible) {
          return <p className="history-no-results">{t('history.noResults', 'No bottles match your search.')}</p>;
        }
        return sections;
      })()}

      </>}
    </div>
  );
}

function HistoryBottleCard({ bottle, cellarId }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const wine = bottle.wineDefinition;
  const consumedDate = bottle.consumedAt
    ? new Date(bottle.consumedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  return (
    <Link
      to={`/cellars/${cellarId}/bottles/${bottle._id}`}
      state={{ fromHistory: true }}
      className={`history-bottle-card ${bottle.consumedReason || bottle.status}`}
    >
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
        <svg className="history-bottle-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
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
    </Link>
  );
}

export default CellarHistory;
