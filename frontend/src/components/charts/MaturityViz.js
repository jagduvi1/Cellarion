import { useTranslation } from 'react-i18next';

function MaturityViz({ maturity, maturityCoverage, total }) {
  const { t } = useTranslation();
  const segments = [
    { key: 'declining',  color: '#C94040', icon: '\u26a0' },
    { key: 'late',       color: '#D4A070', icon: '\u23f1' },
    { key: 'peak',       color: '#7A1E2D', icon: '\u2713' },
    { key: 'early',      color: '#7aade0', icon: '\u25f7' },
    { key: 'notReady',   color: '#5B8DB8', icon: '\u23f3' },
    { key: 'noProfile',  color: '#3a3a3a', icon: '\u2014' },
  ];

  const hasCoverage = maturityCoverage && maturityCoverage.sommSet > 0;

  return (
    <div className="drink-window">
      <div className="drink-bar">
        {total > 0 ? segments.map(seg => {
          const count = maturity[seg.key] || 0;
          const pct   = (count / total) * 100;
          if (pct === 0) return null;
          return (
            <div key={seg.key} className="drink-segment"
              style={{ width: `${pct}%`, background: seg.color }}
              title={`${t(`statistics.maturityPhases.${seg.key}`)}: ${count}`} />
          );
        }) : (
          <div className="drink-segment" style={{ width: '100%', background: '#252525' }} />
        )}
      </div>
      <div className="drink-legend">
        {segments.map(seg => {
          const count = maturity[seg.key] || 0;
          return (
            <div key={seg.key} className="drink-legend-item">
              <span className="drink-legend-dot" style={{ background: seg.color }} />
              <span className="drink-legend-icon">{seg.icon}</span>
              <span className="drink-legend-label">{t(`statistics.maturityPhases.${seg.key}`)}</span>
              <span className="drink-legend-count"
                style={{ color: count > 0 && seg.key !== 'noProfile' ? seg.color : undefined }}>
                {count}
              </span>
            </div>
          );
        })}
      </div>
      {hasCoverage && (
        <div className="drink-coverage-note">
          {t('statistics.maturity.withProfiles', { count: maturityCoverage.sommSet })}
          {maturityCoverage.none > 0 && ` \u00b7 ${t('statistics.maturity.withoutData', { count: maturityCoverage.none })}`}
        </div>
      )}
    </div>
  );
}

export default MaturityViz;
