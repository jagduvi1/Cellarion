import { useTranslation } from 'react-i18next';
import { REASON_COLORS } from './chartHelpers';

function ConsumptionChart({ consumptionByYear, consumptionByReason }) {
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

  return (
    <div>
      <div className="consumption-chart">
        {consumptionByYear.map((d, i) => {
          const yearTotal = reasons.reduce((s, r) => s + (d[r] || 0), 0);
          return (
            <div key={i} className="consumption-year-col">
              <div className="consumption-bar-count">{yearTotal > 0 ? yearTotal : ''}</div>
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
              <div className="consumption-year-label">{d.year}</div>
            </div>
          );
        })}
      </div>
      <div className="consumption-legend">
        {reasons.map(r => (
          <span key={r} className="consumption-legend-item">
            <span className="consumption-dot" style={{ background: REASON_COLORS[r] }} />
            {reasonLabels[r]}: {consumptionByReason[r] || 0}
          </span>
        ))}
      </div>
      <div className="consumption-totals">
        <strong>{t('statistics.consumption.totalConsumed', { count: total })}</strong>
      </div>
    </div>
  );
}

export default ConsumptionChart;
