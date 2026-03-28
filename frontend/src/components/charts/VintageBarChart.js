import { useTranslation } from 'react-i18next';

function VintageBarChart({ data }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) return <p className="stats-empty">{t('statistics.noVintageData')}</p>;

  const numeric  = data.filter(d => d.year !== 'NV');
  const nvItem   = data.find(d => d.year === 'NV');
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const BAR_HEIGHT = 160;

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {numeric.map((d, i) => (
          <div key={i} className="vintage-bar-wrap"
            title={t('statistics.vintageBottle', { vintage: d.year, count: d.count })}>
            <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
            <div className="vintage-bar"
              style={{ height: `${Math.max(4, (d.count / maxCount) * BAR_HEIGHT)}px` }} />
            <div className="vintage-bar-label">
              {numeric.length > 20 ? String(d.year).slice(-2) : d.year}
            </div>
          </div>
        ))}
        {nvItem && (
          <div className="vintage-bar-wrap vintage-bar-wrap--nv"
            title={t('statistics.vintageBottle', { vintage: 'NV', count: nvItem.count })}>
            <div className="vintage-bar-count">{nvItem.count}</div>
            <div className="vintage-bar vintage-bar--nv"
              style={{ height: `${Math.max(4, (nvItem.count / maxCount) * BAR_HEIGHT)}px` }} />
            <div className="vintage-bar-label">NV</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default VintageBarChart;
