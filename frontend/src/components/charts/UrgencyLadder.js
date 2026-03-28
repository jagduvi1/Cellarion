import { useTranslation } from 'react-i18next';
import { TYPE_COLORS, fmtDays, fmtCurrency } from './chartHelpers';

function UrgencyLadder({ bottles, currency }) {
  const { t } = useTranslation();
  if (!bottles || bottles.length === 0) {
    return (
      <p className="stats-empty">
        {t('statistics.urgency.noUrgent')}
      </p>
    );
  }

  return (
    <ol className="urgency-list">
      {bottles.map((b, i) => {
        const isDeclining = b.status === 'declining';
        const color       = isDeclining ? '#C94040' : '#D4A070';
        return (
          <li key={i} className="urgency-item">
            <span className="urgency-rank" style={{ color }}>{i + 1}</span>
            <span className="urgency-type-dot"
              style={{ background: TYPE_COLORS[b.type] || '#7A1E2D' }}
              title={t(`statistics.typeLabels.${b.type}`, { defaultValue: b.type })} />
            <div className="urgency-info">
              <div className="urgency-name" title={b.name}>{b.name}</div>
              <div className="urgency-meta">
                {b.producer}{b.producer && b.vintage ? ' \u00b7 ' : ''}{b.vintage}
                {b.source === 'somm' && <span className="urgency-source-badge">somm</span>}
              </div>
            </div>
            <div className="urgency-right">
              <span className="urgency-days" style={{ color }}>
                {isDeclining
                  ? t('statistics.days.ago', { count: Math.abs(b.daysRemaining || 0) })
                  : fmtDays(b.daysRemaining, t)}
              </span>
              {b.price && (
                <span className="urgency-price">{fmtCurrency(b.price, currency)}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default UrgencyLadder;
