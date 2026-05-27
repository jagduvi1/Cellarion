/**
 * `onSizeClick(size)` makes each row a clickable deep-link target.
 */
function BottleSizeChart({ byBottleSize, onSizeClick }) {
  const entries = Object.entries(byBottleSize).sort((a, b) => b[1] - a[1]);
  if (entries.length <= 1) return null;
  const total      = entries.reduce((s, [, v]) => s + v, 0);
  const sizeColors = ['#7A1E2D', '#6EC6C6', '#D4C87A', '#D4A070', '#8B6A9A'];
  const clickable = typeof onSizeClick === 'function';

  return (
    <div className="hbar-chart">
      {entries.map(([size, count], i) => {
        const inner = (
          <>
            <span className="hbar-label">{size}</span>
            <div className="hbar-track">
              <div className="hbar-fill" style={{
                width: `${(count / total) * 100}%`,
                background: sizeColors[i % sizeColors.length],
              }} />
            </div>
            <span className="hbar-count">{count}</span>
            <span className="hbar-pct">{((count / total) * 100).toFixed(0)}%</span>
          </>
        );
        return clickable ? (
          <button
            key={size}
            type="button"
            className="hbar-row hbar-row--clickable"
            onClick={() => onSizeClick(size)}
          >
            {inner}
          </button>
        ) : (
          <div key={size} className="hbar-row">{inner}</div>
        );
      })}
    </div>
  );
}

export default BottleSizeChart;
