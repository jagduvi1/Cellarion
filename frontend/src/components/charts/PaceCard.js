import { useTranslation } from 'react-i18next';

function PaceCard({ pace, totalBottles }) {
  const { t } = useTranslation();
  const { avgIntakePerYear, avgOutputPerYear, netPerYear, runway } = pace;
  const isGrowing    = netPerYear > 0;
  const isShrinking  = netPerYear < 0;
  const netColor     = isGrowing ? '#7aade0' : isShrinking ? '#C94040' : '#9A9484';
  const netLabel     = isGrowing
    ? t('statistics.pace.growing')
    : isShrinking
      ? t('statistics.pace.shrinking')
      : t('statistics.pace.balanced');

  return (
    <div className="pace-card">
      <div className="pace-stats">
        <div className="pace-stat">
          <span className="pace-stat-value">{avgIntakePerYear}</span>
          <span className="pace-stat-label">{t('statistics.pace.bottlesIn')}</span>
        </div>
        <div className="pace-divider" />
        <div className="pace-stat">
          <span className="pace-stat-value">{avgOutputPerYear}</span>
          <span className="pace-stat-label">{t('statistics.pace.bottlesOut')}</span>
        </div>
        <div className="pace-divider" />
        <div className="pace-stat">
          <span className="pace-stat-value" style={{ color: netColor }}>
            {netPerYear > 0 ? '+' : ''}{netPerYear}
          </span>
          <span className="pace-stat-label" style={{ color: netColor }}>{netLabel}</span>
        </div>
      </div>
      {runway !== null && (
        <div className="pace-runway">
          <span className="pace-runway-num">{runway}</span>
          <span className="pace-runway-label">
            {t('statistics.pace.runway', { count: runway })}
          </span>
        </div>
      )}
      {avgOutputPerYear === 0 && (
        <p className="stats-empty" style={{ marginTop: '0.75rem' }}>
          {t('statistics.pace.consumeToSee')}
        </p>
      )}
    </div>
  );
}

export default PaceCard;
