import { useTranslation } from 'react-i18next';
import { TYPE_COLORS, fmtRating, fmtDelta } from './chartHelpers';

function RegretSignalCard({ regretSignal, targetScale }) {
  const { t } = useTranslation();
  if (!regretSignal) return null;
  const { surprises, disappointments, avgDelta, count } = regretSignal;

  if (count === 0) {
    return (
      <p className="stats-empty">
        {t('statistics.regretSignal.empty')}
      </p>
    );
  }

  return (
    <div className="regret-signal">
      {avgDelta !== null && (
        <div className="regret-signal-avg">
          {t('statistics.regretSignal.avgDelta')} <strong style={{ color: avgDelta >= 0 ? '#7A1E2D' : '#C94040' }}>
            {avgDelta >= 0 ? '+' : '\u2212'}{fmtDelta(Math.abs(avgDelta), targetScale)}
          </strong> {t('statistics.regretSignal.acrossBottles', { count })}
        </div>
      )}
      <div className="regret-signal-cols">
        <div className="regret-signal-col">
          <div className="regret-signal-col-header regret-signal-col-header--good">
            {'\ud83c\udf89'} {t('statistics.regretSignal.surprises')}
          </div>
          {surprises.length === 0
            ? <p className="stats-empty" style={{ margin: '0.5rem 0' }}>{t('statistics.noneYet')}</p>
            : surprises.map((b, i) => (
              <div key={i} className="regret-signal-item">
                <span className="rs-dot" style={{ background: TYPE_COLORS[b.type] || '#7A1E2D' }} />
                <div className="rs-info">
                  <div className="rs-name">{b.name}</div>
                  <div className="rs-vintage">{b.vintage}</div>
                </div>
                <div className="rs-delta rs-delta--positive">+{fmtDelta(b.delta, targetScale)}</div>
                <div className="rs-ratings">{fmtRating(b.rating, targetScale)} {'\u2192'} {fmtRating(b.consumedRating, targetScale)}</div>
              </div>
            ))}
        </div>
        <div className="regret-signal-col">
          <div className="regret-signal-col-header regret-signal-col-header--bad">
            {'\ud83d\ude2c'} {t('statistics.regretSignal.disappointments')}
          </div>
          {disappointments.length === 0
            ? <p className="stats-empty" style={{ margin: '0.5rem 0' }}>{t('statistics.noneYet')}</p>
            : disappointments.map((b, i) => (
              <div key={i} className="regret-signal-item">
                <span className="rs-dot" style={{ background: TYPE_COLORS[b.type] || '#7A1E2D' }} />
                <div className="rs-info">
                  <div className="rs-name">{b.name}</div>
                  <div className="rs-vintage">{b.vintage}</div>
                </div>
                <div className="rs-delta rs-delta--negative">{fmtDelta(b.delta, targetScale)}</div>
                <div className="rs-ratings">{fmtRating(b.rating, targetScale)} {'\u2192'} {fmtRating(b.consumedRating, targetScale)}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

export default RegretSignalCard;
