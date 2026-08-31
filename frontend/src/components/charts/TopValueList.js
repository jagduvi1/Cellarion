import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TYPE_COLORS, fmtCurrency } from './chartHelpers';

/**
 * "Most Valuable Bottles". Rows link to their bottle when the payload carries
 * both the bottle and cellar ids — the page is /cellars/:cellarId/bottles/:id
 * (see UrgencyLadder for the same pattern); rows missing either stay plain text.
 */
function TopValueList({ bottles, currency }) {
  const { t } = useTranslation();
  if (!bottles || bottles.length === 0) {
    return <p className="stats-empty">{t('statistics.topValue.empty')}</p>;
  }

  return (
    <ol className="top-bottles-list">
      {bottles.map((b, i) => (
        <li key={i} className="top-bottle-item">
          <span className="top-bottle-rank" data-rank={i + 1}>#{i + 1}</span>
          <span className="top-bottle-type-dot"
            style={{ background: TYPE_COLORS[b.type] || '#7A1E2D' }}
            title={t(`statistics.typeLabels.${b.type}`, { defaultValue: b.type })} />
          {b.id && b.cellarId ? (
            <Link to={`/cellars/${b.cellarId}/bottles/${b.id}`} className="top-bottle-info top-bottle-info--link" title={t('statistics.openBottle')}>
              <div className="top-bottle-name" title={b.name}>{b.name}</div>
              <div className="top-bottle-meta">
                {b.producer}{b.producer && b.vintage ? ' \u00b7 ' : ''}{b.vintage}
              </div>
            </Link>
          ) : (
            <div className="top-bottle-info">
              <div className="top-bottle-name" title={b.name}>{b.name}</div>
              <div className="top-bottle-meta">
                {b.producer}{b.producer && b.vintage ? ' \u00b7 ' : ''}{b.vintage}
              </div>
            </div>
          )}
          <span className="top-bottle-price" style={{ color: TYPE_COLORS[b.type] || '#7A1E2D' }}>
            {fmtCurrency(b.price, currency)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default TopValueList;
