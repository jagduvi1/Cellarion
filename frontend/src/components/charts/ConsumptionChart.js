import { useTranslation } from 'react-i18next';
import { REASON_COLORS } from './chartHelpers';

/**
 * `onYearClick(year)` makes each year's bar stack clickable as a whole
 * (filters by consumedYear). `onReasonClick(reason)` makes the legend
 * items clickable (filters by lifecycle status — drank/gifted/sold/other).
 */
function ConsumptionChart({ consumptionByYear, consumptionByReason, onYearClick, onReasonClick }) {
  const { t } = useTranslation();
  if (!consumptionByYear || consumptionByYear.length === 0) {
    return (
      <p className="stats-empty">
        {t('statistics.consumption.empty')}
      </p>
    );
  }

  const reasons  = ['drank', 'gifted', 'sold', 'other'];
  const reasonLabels = {
    drank:  t('statistics.consumption.drank'),
    gifted: t('statistics.consumption.gifted'),
    sold:   t('statistics.consumption.sold'),
    other:  t('statistics.consumption.other'),
  };
  const maxTotal = Math.max(
    ...consumptionByYear.map(d => reasons.reduce((s, r) => s + (d[r] || 0), 0)), 1
  );
  const BAR_H = 120;
  const total = Object.values(consumptionByReason).reduce((s, v) => s + v, 0);
  const yearClickable = typeof onYearClick === 'function';
  const reasonClickable = typeof onReasonClick === 'function';

  return (
    <div>
      <div className="consumption-chart">
        {consumptionByYear.map((d, i) => {
          const yearTotal = reasons.reduce((s, r) => s + (d[r] || 0), 0);
          const stack = (
            <div className="consumption-bar-stack" style={{ height: `${BAR_H}px` }}
              title={t('statistics.vintageBottle', { vintage: d.year, count: yearTotal })}>
              {reasons.map(r => {
                const h = maxTotal > 0 ? ((d[r] || 0) / maxTotal) * BAR_H : 0;
                if (h === 0) return null;
                return (
                  <div key={r} className="consumption-segment"
                    style={{ height: `${h}px`, background: REASON_COLORS[r] }}
                    title={`${reasonLabels[r]}: ${d[r] || 0}`} />
                );
              })}
            </div>
          );
          const col = (
            <>
              <div className="consumption-bar-count">{yearTotal > 0 ? yearTotal : ''}</div>
              {stack}
              <div className="consumption-year-label">{d.year}</div>
            </>
          );
          return yearClickable && yearTotal > 0 ? (
            <button
              key={i}
              type="button"
              className="consumption-year-col consumption-year-col--clickable"
              onClick={() => onYearClick(d.year)}
            >
              {col}
            </button>
          ) : (
            <div key={i} className="consumption-year-col">{col}</div>
          );
        })}
      </div>
      <div className="consumption-legend">
        {reasons.map(r => {
          const count = consumptionByReason[r] || 0;
          const content = (
            <>
              <span className="consumption-dot" style={{ background: REASON_COLORS[r] }} />
              {reasonLabels[r]}: {count}
            </>
          );
          return reasonClickable && count > 0 ? (
            <button
              key={r}
              type="button"
              className="consumption-legend-item consumption-legend-item--clickable"
              onClick={() => onReasonClick(r)}
            >
              {content}
            </button>
          ) : (
            <span key={r} className="consumption-legend-item">{content}</span>
          );
        })}
      </div>
      <div className="consumption-totals">
        <strong>{t('statistics.consumption.totalConsumed', { count: total })}</strong>
      </div>
    </div>
  );
}

export default ConsumptionChart;
