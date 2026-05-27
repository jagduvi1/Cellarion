import { useTranslation } from 'react-i18next';

/**
 * `onBarClick(year)` makes each vintage bar a clickable deep-link target.
 */
function VintageBarChart({ data, onBarClick }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) return <p className="stats-empty">{t('statistics.noVintageData')}</p>;

  const numeric  = data.filter(d => d.year !== 'NV');
  const nvItem   = data.find(d => d.year === 'NV');
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const BAR_HEIGHT = 160;
  const clickable = typeof onBarClick === 'function';

  const renderBar = (d, extraClass = '') => {
    const title = t('statistics.vintageBottle', { vintage: d.year, count: d.count });
    const content = (
      <>
        <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
        <div className={`vintage-bar${extraClass ? ` ${extraClass}` : ''}`}
          style={{ height: `${Math.max(4, (d.count / maxCount) * BAR_HEIGHT)}px` }} />
        <div className="vintage-bar-label">
          {numeric.length > 20 ? String(d.year).slice(-2) : d.year}
        </div>
      </>
    );
    return clickable ? (
      <button
        key={d.year}
        type="button"
        className={`vintage-bar-wrap vintage-bar-wrap--clickable${extraClass ? ` vintage-bar-wrap--nv` : ''}`}
        title={title}
        onClick={() => onBarClick(d.year)}
      >
        {content}
      </button>
    ) : (
      <div
        key={d.year}
        className={`vintage-bar-wrap${extraClass ? ` vintage-bar-wrap--nv` : ''}`}
        title={title}
      >
        {content}
      </div>
    );
  };

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {numeric.map(d => renderBar(d))}
        {nvItem && renderBar({ ...nvItem, year: 'NV' }, 'vintage-bar--nv')}
      </div>
    </div>
  );
}

export default VintageBarChart;
