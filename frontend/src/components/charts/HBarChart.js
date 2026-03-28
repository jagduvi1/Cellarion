import { useTranslation } from 'react-i18next';

function HBarChart({ data, colors, maxItems = 12 }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) return <p className="stats-empty">{t('statistics.noDataYet')}</p>;
  const items  = data.slice(0, maxItems);
  const maxVal = Math.max(...items.map(d => d.count), 1);

  return (
    <div className="hbar-chart">
      {items.map((d, i) => (
        <div key={i} className="hbar-row">
          <span className="hbar-label" title={d.name}>{d.name}</span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{
              width: `${(d.count / maxVal) * 100}%`,
              background: Array.isArray(colors)
                ? (colors[i % colors.length] || '#7A1E2D')
                : (colors || '#7A1E2D'),
            }} />
          </div>
          <span className="hbar-count">{d.count}</span>
        </div>
      ))}
    </div>
  );
}

export default HBarChart;
