import { useTranslation } from 'react-i18next';
import { formatVintage } from '../../utils/vintage';

/**
 * `onBarClick(year)` makes each vintage bar a clickable deep-link target.
 */
function VintageBarChart({ data, onBarClick }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) return <p className="stats-empty">{t('statistics.noVintageData')}</p>;

  // The two stored codes are bars of their own, after the years, labelled
  // through the display helper (release audit 2026-10-28: 'Unknown' used to
  // sit among the years as a raw word, sliced to "wn" past twenty bars).
  const CODES = ['NV', 'Unknown'];
  const numeric  = data.filter(d => !CODES.includes(String(d.year)));
  const nvItem   = data.find(d => d.year === 'NV');
  const unknownItem = data.find(d => d.year === 'Unknown');
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const BAR_HEIGHT = 160;
  const clickable = typeof onBarClick === 'function';

  const renderBar = (d, extraClass = '') => {
    const title = t('statistics.vintageBottle', { vintage: formatVintage(d.year, t), count: d.count });
    const content = (
      <>
        <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
        <div className={`vintage-bar${extraClass ? ` ${extraClass}` : ''}`}
          style={{ height: `${Math.max(4, (d.count / maxCount) * BAR_HEIGHT)}px` }} />
        <div className="vintage-bar-label">
          {CODES.includes(String(d.year)) ? formatVintage(d.year, t) : numeric.length > 20 ? String(d.year).slice(-2) : d.year}
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
        {unknownItem && renderBar({ ...unknownItem, year: 'Unknown' }, 'vintage-bar--nv')}
      </div>
    </div>
  );
}

export default VintageBarChart;
