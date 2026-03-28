import { useTranslation } from 'react-i18next';

function RegretIndexCard({ regretIndex, decliningCount, total }) {
  const { t } = useTranslation();
  const level =
    regretIndex >= 30 ? 'critical' :
    regretIndex >= 15 ? 'warning'  :
    regretIndex > 0   ? 'mild'     : 'great';

  const levelColors = {
    critical: '#C94040',
    warning:  '#D4A070',
    mild:     '#D4C87A',
    great:    '#7A1E2D',
  };

  const color = levelColors[level];

  return (
    <div className="regret-card">
      <div className="regret-number" style={{ color }}>
        {regretIndex}%
      </div>
      <div className="regret-label">{t('statistics.sections.regretIndex')}</div>
      <div className="regret-desc">
        {t('statistics.regret.pastPrime', { count: decliningCount })}
      </div>
      <div className="regret-message" style={{ borderLeftColor: color, color: '#E8DFD0' }}>
        {t(`statistics.regret.${level}`)}
      </div>
      {total > 0 && (
        <div className="regret-bar-wrap">
          <div className="regret-bar-track">
            <div
              className="regret-bar-fill"
              style={{ width: `${Math.min(100, regretIndex)}%`, background: color }}
            />
          </div>
          <span className="regret-bar-label">{t('statistics.regret.ofProfiled')}</span>
        </div>
      )}
    </div>
  );
}

export default RegretIndexCard;
