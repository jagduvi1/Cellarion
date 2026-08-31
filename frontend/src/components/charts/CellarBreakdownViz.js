import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fmtCurrency } from './chartHelpers';

/**
 * Cellar breakdown. Each cellar's name links to the cellar itself when the
 * payload carries an id — the "from the cellars" half of the forum request
 * (turbulent3964 2026-08-29). Only the name is a link, not the whole row: the
 * bar and meta line are a measurement, and making a 100%-wide bar clickable
 * reads as a mis-target.
 */
function CellarBreakdownViz({ cellars, currency }) {
  const { t } = useTranslation();
  if (!cellars || cellars.length === 0) return <p className="stats-empty">{t('statistics.noCellars')}</p>;
  const maxCount = Math.max(...cellars.map(c => c.bottleCount), 1);

  return (
    <div className="cellar-breakdown">
      {cellars.map((c, i) => (
        <div key={i} className="cellar-breakdown-row">
          <div className="cellar-breakdown-header">
            {c.id ? (
              <Link to={`/cellars/${c.id}`} className="cellar-breakdown-name cellar-breakdown-name--link">{c.name}</Link>
            ) : (
              <span className="cellar-breakdown-name">{c.name}</span>
            )}
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
