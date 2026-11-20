import { useTranslation } from 'react-i18next';
import { REGRET_LEVEL_COLORS, regretLevel } from './chartHelpers';

function RegretIndexCard({ regretIndex, decliningCount, total }) {
  const { t } = useTranslation();
  const level = regretLevel(regretIndex);
  const color = REGRET_LEVEL_COLORS[level];

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
