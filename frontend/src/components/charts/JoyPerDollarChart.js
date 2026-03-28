import { useTranslation } from 'react-i18next';
import { TYPE_COLORS, fmtRating, fmtCurrency } from './chartHelpers';

function JoyPerDollarChart({ data, currency, targetScale }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) {
    return (
      <p className="stats-empty">
        {t('statistics.joyPerDollar.empty', { currency })}
      </p>
    );
  }
  const maxScore = Math.max(...data.map(d => d.score), 1);

  return (
    <div>
      <div className="jpd-chart">
        {data.map((d, i) => (
          <div key={i} className="jpd-row">
            <span className="jpd-dot"
              style={{ background: TYPE_COLORS[d.type] || '#7A1E2D' }} />
            <span className="jpd-label">{t(`statistics.typeLabels.${d.type}`, { defaultValue: d.type })}</span>
            <div className="jpd-track">
              <div className="jpd-fill"
                style={{
                  width:      `${(d.score / maxScore) * 100}%`,
                  background: TYPE_COLORS[d.type] || '#7A1E2D',
                }} />
            </div>
            <div className="jpd-stats">
              <span className="jpd-rating">{fmtRating(d.avgRating, targetScale)}</span>
              <span className="jpd-price">{t('statistics.joyPerDollar.avg', { price: fmtCurrency(d.avgPrice, currency) })}</span>
              <span className="jpd-count">{t('statistics.joyPerDollar.count', { count: d.count })}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="jpd-note">{t('statistics.joyPerDollar.note', { currency })}</p>
    </div>
  );
}

export default JoyPerDollarChart;
