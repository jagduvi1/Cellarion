import { useTranslation } from 'react-i18next';
import { fmtCurrency } from './chartHelpers';

function CellarBreakdownViz({ cellars, currency }) {
  const { t } = useTranslation();
  if (!cellars || cellars.length === 0) return <p className="stats-empty">{t('statistics.noCellars')}</p>;
  const maxCount = Math.max(...cellars.map(c => c.bottleCount), 1);

  return (
    <div className="cellar-breakdown">
      {cellars.map((c, i) => (
        <div key={i} className="cellar-breakdown-row">
          <div className="cellar-breakdown-header">
            <span className="cellar-breakdown-name">{c.name}</span>
            {c.value > 0 && (
              <span className="cellar-breakdown-value">{fmtCurrency(c.value, currency)}</span>
            )}
          </div>
          <div className="cellar-breakdown-track">
            <div className="cellar-breakdown-fill"
              style={{ width: `${(c.bottleCount / maxCount) * 100}%` }} />
          </div>
          <div className="cellar-breakdown-meta">
            <span>{t('statistics.cellarBreakdown.bottle', { count: c.bottleCount })}</span>
            <span>{t('statistics.cellarBreakdown.uniqueWine', { count: c.uniqueWines })}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default CellarBreakdownViz;
