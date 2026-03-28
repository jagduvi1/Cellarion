import { useTranslation } from 'react-i18next';
import { RATING_BAND_DEFS, bandSub, fmtRating } from './chartHelpers';

function RatingChart({ byRating, avg, targetScale }) {
  const { t } = useTranslation();
  const total  = Object.values(byRating).reduce((s, v) => s + v, 0);
  const maxVal = Math.max(...Object.values(byRating), 1);

  return (
    <div className="rating-chart">
      {RATING_BAND_DEFS.map(band => {
        const count = byRating[band.key] || 0;
        const pct   = total > 0 ? (count / total) * 100 : 0;
        return (
          <div key={band.key} className="rating-row" title={bandSub(band.key, targetScale)}>
            <span className="rating-stars" style={{ color: band.color }}>
              {t(`statistics.ratingBands.${band.labelKey}`)}
            </span>
            <div className="rating-track">
              <div className="rating-fill" style={{ width: `${(count / maxVal) * 100}%`, background: band.color }} />
            </div>
            <span className="rating-count">{count}</span>
            <span className="rating-pct">{pct.toFixed(0)}%</span>
          </div>
        );
      })}
      {avg != null && (
        <div className="rating-avg">
          {t('statistics.rating.average')} <strong>{fmtRating(avg, targetScale)}</strong>
          {total > 0 && <span> {t('statistics.rating.acrossBottles', { count: total })}</span>}
        </div>
      )}
      {avg == null && total === 0 && <p className="stats-empty">{t('statistics.noRatedBottles')}</p>}
    </div>
  );
}

export default RatingChart;
