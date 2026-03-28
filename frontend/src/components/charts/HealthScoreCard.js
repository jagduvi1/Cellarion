import { useTranslation } from 'react-i18next';
import { GRADE_COLORS } from './chartHelpers';

function HealthScoreCard({ healthScore, healthGrade, maturity }) {
  const { t } = useTranslation();
  const score    = healthScore ?? 0;
  const gradeColor = healthGrade ? (GRADE_COLORS[healthGrade] || '#7A1E2D') : '#555';
  const withProfile = (maturity.declining || 0) + (maturity.late || 0) + (maturity.peak || 0) + (maturity.early || 0) + (maturity.notReady || 0);

  return (
    <div className="health-card">
      <div className="health-gauge-wrap">
        <div className="health-gauge" style={{
          background: `conic-gradient(${gradeColor} 0% ${score}%, #252525 ${score}% 100%)`,
        }}>
          <div className="health-gauge-inner">
            <span className="health-grade" style={{ color: gradeColor }}>
              {healthGrade || '\u2014'}
            </span>
            <span className="health-score-num">{healthScore !== null ? `${score}/100` : 'N/A'}</span>
          </div>
        </div>
      </div>
      <div className="health-breakdown">
        <div className="health-row">
          <span className="health-dot" style={{ background: '#7A1E2D' }} />
          <span className="health-label">{t('statistics.maturityPhases.peak')}</span>
          <span className="health-val">{maturity.peak}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#7aade0' }} />
          <span className="health-label">{t('statistics.maturityPhases.early')}</span>
          <span className="health-val">{maturity.early}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#D4A070' }} />
          <span className="health-label">{t('statistics.maturityPhases.late')}</span>
          <span className="health-val">{maturity.late}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#C94040' }} />
          <span className="health-label">{t('statistics.maturityPhases.declining')}</span>
          <span className="health-val">{maturity.declining}</span>
        </div>
        {withProfile === 0 && (
          <p className="stats-empty" style={{ margin: '0.5rem 0 0' }}>
            {t('statistics.maturity.profilesNeeded')}
          </p>
        )}
      </div>
    </div>
  );
}

export default HealthScoreCard;
