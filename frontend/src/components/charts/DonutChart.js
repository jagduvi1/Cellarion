import { useTranslation } from 'react-i18next';

function DonutChart({ segments, total }) {
  const { t } = useTranslation();
  const size = 180;
  const R  = size * 0.355;
  const C  = 2 * Math.PI * R;
  const cx = size / 2;
  const cy = size / 2;
  const validSegs = segments.filter(s => s.value > 0);
  let cumulative  = 0;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="donut-svg"
      role="img"
      aria-label={t('statistics.donut.ariaLabel', { count: total })}
    >
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#252525" strokeWidth="22" />
      {total > 0 && validSegs.map((seg, i) => {
        const len       = (seg.value / total) * C;
        const dashoffset = C / 4 - cumulative;
        cumulative += len;
        return (
          <circle key={i}
            cx={cx} cy={cy} r={R}
            fill="none" stroke={seg.color} strokeWidth="20"
            strokeDasharray={`${len} ${C}`} strokeDashoffset={dashoffset}
            strokeLinecap="butt"
          >
            <title>{seg.label}: {seg.value} ({total > 0 ? ((seg.value / total) * 100).toFixed(1) : 0}%)</title>
          </circle>
        );
      })}
      <text x={cx} y={cy - size * 0.06} textAnchor="middle"
        fontSize={size * 0.155} fontWeight="700" fill="#E8DFD0">{total}</text>
      <text x={cx} y={cy + size * 0.1} textAnchor="middle"
        fontSize={size * 0.07} fill="#9A9484">{t('statistics.donut.bottles')}</text>
    </svg>
  );
}

export default DonutChart;
