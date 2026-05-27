import { useTranslation } from 'react-i18next';

/**
 * `onItemClick(item)` makes each row a clickable deep-link target.
 * When provided, rows render as `<button>` so they're keyboard-accessible
 * and get a hover affordance via CSS.
 */
function HBarChart({ data, colors, maxItems = 12, onItemClick }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) return <p className="stats-empty">{t('statistics.noDataYet')}</p>;
  const items  = data.slice(0, maxItems);
  const maxVal = Math.max(...items.map(d => d.count), 1);
  const clickable = typeof onItemClick === 'function';

  return (
    <div className="hbar-chart">
      {items.map((d, i) => {
        const inner = (
          <>
            <span className="hbar-label" title={d.name}>{d.name}</span>
            <div className="hbar-track">
              <div className="hbar-fill" style={{
                width: `${(d.count / maxVal) * 100}%`,
                background: Array.isArray(colors)
                  ? (colors[i % colors.length] || '#7A1E2D')
                  : (colors || '#7A1E2D'),
              }} />
            </div>
            <span className="hbar-count">{d.count}</span>
          </>
        );
        return clickable ? (
          <button
            key={i}
            type="button"
            className="hbar-row hbar-row--clickable"
            onClick={() => onItemClick(d)}
          >
            {inner}
          </button>
        ) : (
          <div key={i} className="hbar-row">{inner}</div>
        );
      })}
    </div>
  );
}

export default HBarChart;
