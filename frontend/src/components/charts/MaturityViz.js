import { useTranslation } from 'react-i18next';
import { MATURITY_PHASES } from './chartHelpers';

/**
 * `onSegmentClick(segmentKey)` makes each legend row + bar segment a
 * clickable deep-link target. `segmentKey` matches the maturity buckets
 * used by the backend filter (e.g. 'peak', 'declining', 'not-ready',
 * 'none' for bottles without a sommelier profile).
 */
function MaturityViz({ maturity, maturityCoverage, total, onSegmentClick }) {
  const { t } = useTranslation();
  const segments = MATURITY_PHASES;

  const hasCoverage = maturityCoverage && maturityCoverage.sommSet > 0;
  const clickable = typeof onSegmentClick === 'function';

  return (
    <div className="drink-window">
      <div className="drink-bar">
        {total > 0 ? segments.map(seg => {
          const count = maturity[seg.key] || 0;
          const pct   = (count / total) * 100;
          if (pct === 0) return null;
          const title = `${t(`statistics.maturityPhases.${seg.key}`)}: ${count}`;
          return clickable ? (
            <button
              key={seg.key}
              type="button"
              className="drink-segment drink-segment--clickable"
              style={{ width: `${pct}%`, background: seg.color }}
              title={title}
              onClick={() => onSegmentClick(seg.filter)}
            />
          ) : (
            <div key={seg.key} className="drink-segment"
              style={{ width: `${pct}%`, background: seg.color }}
              title={title} />
          );
        }) : (
          <div className="drink-segment" style={{ width: '100%', background: '#252525' }} />
        )}
      </div>
      <div className="drink-legend">
        {segments.map(seg => {
          const count = maturity[seg.key] || 0;
          const content = (
            <>
              <span className="drink-legend-dot" style={{ background: seg.color }} />
              <span className="drink-legend-icon">{seg.icon}</span>
              <span className="drink-legend-label">{t(`statistics.maturityPhases.${seg.key}`)}</span>
              <span className="drink-legend-count"
                style={{ color: count > 0 && seg.key !== 'noProfile' ? seg.color : undefined }}>
                {count}
              </span>
            </>
          );
          return clickable && count > 0 ? (
            <button
              key={seg.key}
              type="button"
              className="drink-legend-item drink-legend-item--clickable"
              onClick={() => onSegmentClick(seg.filter)}
            >
              {content}
            </button>
          ) : (
            <div key={seg.key} className="drink-legend-item">{content}</div>
          );
        })}
      </div>
      {hasCoverage && (
        <div className="drink-coverage-note">
          {t('statistics.maturity.withProfiles', { count: maturityCoverage.sommSet })}
          {maturityCoverage.none > 0 && ` · ${t('statistics.maturity.withoutData', { count: maturityCoverage.none })}`}
        </div>
      )}
    </div>
  );
}

export default MaturityViz;
