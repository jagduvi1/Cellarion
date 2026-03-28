import { useTranslation } from 'react-i18next';
import { TYPE_COLORS, fmtCurrency } from './chartHelpers';

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
          <div className="top-bottle-info">
            <div className="top-bottle-name" title={b.name}>{b.name}</div>
            <div className="top-bottle-meta">
              {b.producer}{b.producer && b.vintage ? ' \u00b7 ' : ''}{b.vintage}
            </div>
          </div>
          <span className="top-bottle-price" style={{ color: TYPE_COLORS[b.type] || '#7A1E2D' }}>
            {fmtCurrency(b.price, currency)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default TopValueList;
