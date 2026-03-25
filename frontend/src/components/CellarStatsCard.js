import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { fromNormalized } from '../utils/ratingUtils';
import './CellarStatsCard.css';

/**
 * A visually rich, shareable cellar stats card (Spotify Wrapped style).
 * Rendered as a self-contained div that can be captured to an image.
 *
 * Props:
 *  - stats:       overview stats object from /api/stats/overview
 *  - username:    display name
 *  - showValue:   whether to show cellar value
 *  - ratingScale: user's preferred rating scale
 */
const CellarStatsCard = forwardRef(function CellarStatsCard({ stats, username, showValue, ratingScale }, ref) {
  const { t } = useTranslation();
  if (!stats) return null;

  const { overview, byType, byCountry, topProducers } = stats;
  const topCountry = byCountry?.[0];
  const topProducer = topProducers?.[0];

  // Wine type with most bottles
  const topType = byType
    ? Object.entries(byType).sort((a, b) => b[1] - a[1])[0]
    : null;

  // Rating display
  const scale = ratingScale || '5';
  const ratingDisplay = overview.avgRating != null
    ? fromNormalized(overview.avgRating, scale).toFixed(1)
    : null;
  const ratingSuffix = scale === '100' ? 'pts' : scale === '20' ? '/20' : '★';

  // Type distribution mini bars
  const typeEntries = byType
    ? Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 4)
    : [];
  const typeMax = typeEntries.length > 0 ? typeEntries[0][1] : 1;

  return (
    <div className="stats-card" ref={ref}>
      {/* Background decorative elements */}
      <div className="stats-card__bg-circle stats-card__bg-circle--1" />
      <div className="stats-card__bg-circle stats-card__bg-circle--2" />

      {/* Header */}
      <div className="stats-card__header">
        <div className="stats-card__brand">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2h8l4 10H4L8 2z"/><path d="M12 12v6"/><path d="M8 22h8"/>
          </svg>
          <span>Cellarion</span>
        </div>
        <span className="stats-card__user">{username}</span>
      </div>

      {/* Hero stat */}
      <div className="stats-card__hero">
        <span className="stats-card__hero-number">{overview.totalBottles}</span>
        <span className="stats-card__hero-label">{t('statsCard.bottles', 'bottles in cellar')}</span>
      </div>

      {/* Key metrics grid */}
      <div className="stats-card__grid">
        <div className="stats-card__stat">
          <span className="stats-card__stat-value">{overview.uniqueWines}</span>
          <span className="stats-card__stat-label">{t('statsCard.uniqueWines', 'unique wines')}</span>
        </div>
        <div className="stats-card__stat">
          <span className="stats-card__stat-value">{overview.totalCountries}</span>
          <span className="stats-card__stat-label">{t('statsCard.countries', 'countries')}</span>
        </div>
        {ratingDisplay && (
          <div className="stats-card__stat">
            <span className="stats-card__stat-value">{ratingDisplay}{ratingSuffix}</span>
            <span className="stats-card__stat-label">{t('statsCard.avgRating', 'avg rating')}</span>
          </div>
        )}
        {overview.oldestVintage && (
          <div className="stats-card__stat">
            <span className="stats-card__stat-value">{overview.oldestVintage}</span>
            <span className="stats-card__stat-label">{t('statsCard.oldestVintage', 'oldest vintage')}</span>
          </div>
        )}
      </div>

      {/* Value (optional) */}
      {showValue && overview.totalValue > 0 && (
        <div className="stats-card__value">
          <span className="stats-card__value-amount">
            {new Intl.NumberFormat(undefined, { style: 'currency', currency: overview.currency, maximumFractionDigits: 0 }).format(overview.totalValue)}
          </span>
          <span className="stats-card__value-label">{t('statsCard.cellarValue', 'cellar value')}</span>
        </div>
      )}

      {/* Wine type bars */}
      {typeEntries.length > 0 && (
        <div className="stats-card__types">
          {typeEntries.map(([type, count]) => (
            <div key={type} className="stats-card__type-row">
              <span className={`stats-card__type-dot stats-card__type-dot--${type}`} />
              <span className="stats-card__type-name">{type}</span>
              <div className="stats-card__type-bar-bg">
                <div
                  className={`stats-card__type-bar stats-card__type-bar--${type}`}
                  style={{ width: `${(count / typeMax) * 100}%` }}
                />
              </div>
              <span className="stats-card__type-count">{count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Highlights */}
      <div className="stats-card__highlights">
        {topCountry && (
          <div className="stats-card__highlight">
            <span className="stats-card__highlight-label">{t('statsCard.topCountry', 'Top country')}</span>
            <span className="stats-card__highlight-value">{topCountry.name}</span>
          </div>
        )}
        {topProducer && (
          <div className="stats-card__highlight">
            <span className="stats-card__highlight-label">{t('statsCard.topProducer', 'Top producer')}</span>
            <span className="stats-card__highlight-value">{topProducer.name}</span>
          </div>
        )}
        {topType && (
          <div className="stats-card__highlight">
            <span className="stats-card__highlight-label">{t('statsCard.favoriteType', 'Favorite type')}</span>
            <span className="stats-card__highlight-value">{topType[0]}</span>
          </div>
        )}
        {overview.totalConsumed > 0 && (
          <div className="stats-card__highlight">
            <span className="stats-card__highlight-label">{t('statsCard.bottlesEnjoyed', 'Bottles enjoyed')}</span>
            <span className="stats-card__highlight-value">{overview.totalConsumed}</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="stats-card__footer">
        <span>cellarion.app</span>
      </div>
    </div>
  );
});

export default CellarStatsCard;
