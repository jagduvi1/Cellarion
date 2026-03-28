import { useTranslation } from 'react-i18next';

function PurchaseHistoryChart({ byPurchaseYear }) {
  const { t } = useTranslation();
  if (!byPurchaseYear || byPurchaseYear.length === 0) {
    return <p className="stats-empty">{t('statistics.noPurchaseData')}</p>;
  }
  const maxVal = Math.max(...byPurchaseYear.map(d => d.count), 1);
  const BAR_H  = 80;

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {byPurchaseYear.map((d, i) => (
          <div key={i} className="vintage-bar-wrap"
            title={t('statistics.purchased', { year: d.year, count: d.count })}>
            <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
            <div className="vintage-bar"
              style={{
                height: `${Math.max(4, (d.count / maxVal) * BAR_H)}px`,
                background: 'linear-gradient(to top, #5f7a8a, #7aade0)',
              }} />
            <div className="vintage-bar-label">
              {byPurchaseYear.length > 15 ? String(d.year).slice(-2) : d.year}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default PurchaseHistoryChart;
