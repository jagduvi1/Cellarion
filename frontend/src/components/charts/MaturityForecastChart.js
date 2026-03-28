import { useTranslation } from 'react-i18next';

function MaturityForecastChart({ forecast }) {
  const { t } = useTranslation();
  if (!forecast || forecast.length === 0) return <p className="stats-empty">{t('statistics.noForecast')}</p>;
  const maxCount = Math.max(...forecast.map(d => d.count), 1);
  const BAR_H    = 120;

  return (
    <div className="forecast-chart">
      {forecast.map((d, i) => (
        <div key={i} className={`forecast-col${d.isCurrent ? ' forecast-col--current' : ''}`}
          title={t('statistics.forecast.inWindow', { year: d.year, count: d.count })}>
          <div className="forecast-count">{d.count > 0 ? d.count : ''}</div>
          <div className="forecast-bar"
            style={{ height: `${Math.max(d.count > 0 ? 4 : 0, (d.count / maxCount) * BAR_H)}px` }} />
          <div className="forecast-year">{d.year}</div>
          {d.isCurrent && <div className="forecast-now-label">{t('statistics.forecast.now')}</div>}
        </div>
      ))}
    </div>
  );
}

export default MaturityForecastChart;
