import { useTranslation } from 'react-i18next';
import { RATING_BAND_DEFS, bandSub, fmtRating } from './chartHelpers';

/**
 * `onBandClick(band)` makes each rating band a clickable deep-link target.
 * The band object includes a `min` value (normalised 0-100) the caller can
 * use to deep-link with `minRating=<min>`.
 */
function RatingChart({ byRating, avg, targetScale, onBandClick }) {
  const { t } = useTranslation();
  const total  = Object.values(byRating).reduce((s, v) => s + v, 0);
  const maxVal = Math.max(...Object.values(byRating), 1);
  const clickable = typeof onBandClick === 'function';

  return (
    <div className="rating-chart">
      {RATING_BAND_DEFS.map(band => {
        const count = byRating[band.key] || 0;
        const pct   = total > 0 ? (count / total) * 100 : 0;
        const content = (
          <>
            <span className="rating-stars" style={{ color: band.color }}>
              {t(`statistics.ratingBands.${band.labelKey}`)}
            </span>
            <div className="rating-track">
              <div className="rating-fill" style={{ width: `${(count / maxVal) * 100}%`, background: band.color }} />
            </div>
            <span className="rating-count">{count}</span>
            <span className="rating-pct">{pct.toFixed(0)}%</span>
          </>
        );
        return clickable && count > 0 ? (
          <button
            key={band.key}
            type="button"
            className="rating-row rating-row--clickable"
            title={bandSub(band.key, targetScale)}
            onClick={() => onBandClick(band)}
          >
            {content}
          </button>
        ) : (
          <div key={band.key} className="rating-row" title={bandSub(band.key, targetScale)}>
            {content}
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
