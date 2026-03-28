import { useTranslation } from 'react-i18next';
import { fmtRating } from './chartHelpers';

function HoldingTimeChart({ holdingTime, targetScale }) {
  const { t } = useTranslation();
  const hasData = holdingTime && holdingTime.some(d => d.count > 0);
  if (!hasData) {
    return (
      <p className="stats-empty">
        {t('statistics.holdingTime.empty')}
      </p>
    );
  }
  const maxCount = Math.max(...holdingTime.map(d => d.count), 1);

  return (
    <div>
      <div className="holding-chart">
        {holdingTime.map((d, i) => (
          <div key={i} className="holding-row">
            <span className="holding-bucket">{d.bucket}</span>
            <div className="holding-track">
              <div className="holding-fill"
                style={{ width: `${(d.count / maxCount) * 100}%` }} />
            </div>
            <span className="holding-count">{d.count}</span>
            {d.avgConsumedRating != null && (
              <span className="holding-rating">
                {fmtRating(d.avgConsumedRating, targetScale)}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="holding-note">
        {t('statistics.holdingTime.note')}
      </p>
    </div>
  );
}

export default HoldingTimeChart;
