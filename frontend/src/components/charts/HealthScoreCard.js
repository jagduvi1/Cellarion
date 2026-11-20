import { useTranslation } from 'react-i18next';
import { GRADE_COLORS, MATURITY_PHASES } from './chartHelpers';
import './HealthScoreCard.css';

// The four phases the score is made of, ripest first.
const CARD_PHASES = ['peak', 'early', 'late', 'declining'].map(key => MATURITY_PHASES.find(p => p.key === key));

/**
 * `onShowMaturity`, when given, makes the phase counts one button that takes
 * the reader to the Maturity Status section, where the same counts are broken
 * down and open their bottles. Without it they are plain text.
 */
function HealthScoreCard({ healthScore, healthGrade, maturity, onShowMaturity }) {
  const { t } = useTranslation();
  const score    = healthScore ?? 0;
  const gradeColor = healthGrade ? (GRADE_COLORS[healthGrade] || '#7A1E2D') : '#555';
  const withProfile = (maturity.declining || 0) + (maturity.late || 0) + (maturity.peak || 0) + (maturity.early || 0) + (maturity.notReady || 0);

  // Spans, not divs: they may sit inside a button.
  const phases = CARD_PHASES.map(p => (
    <span key={p.key} className="health-row">
      <span className="health-dot" style={{ background: p.color }} />
      <span className="health-label">{t(`statistics.maturityPhases.${p.key}`)}</span>
      <span className="health-val">{maturity[p.key]}</span>
    </span>
  ));

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
            <span className="health-score-num">{healthScore !== null ? `${score}/100` : t('statistics.healthNoScore')}</span>
          </div>
        </div>
      </div>
      <div className="health-breakdown">
        {onShowMaturity ? (
          <button type="button" className="health-phases health-phases--link" onClick={onShowMaturity}>
            {phases}
            {/* Completes the button's name: the counts, then where it goes. */}
            <span className="health-phases-hint">
              {t('statistics.maturity.goToSection', { section: t('statistics.sections.maturityStatus') })}
            </span>
          </button>
        ) : (
          <div className="health-phases">{phases}</div>
        )}
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
