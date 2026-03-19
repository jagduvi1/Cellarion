import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from 'recharts';

const CELLAR_COLORS = [
  '#C0504D', '#D4C87A', '#E8A0B0', '#6EC6C6', '#D4A070',
  '#8B6A9A', '#5B8DB8', '#A03648', '#946333', '#3B6D98',
];

function formatDateLabel(dateStr) {
  const [y, m] = dateStr.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m, 10) - 1]} '${y.slice(2)}`;
}

function formatCurrencyValue(amount, currency) {
  if (amount == null) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString()}`;
  }
}

function CustomTooltip({ active, payload, label, currency }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="value-chart-tooltip">
      <p className="value-chart-tooltip-date">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="value-chart-tooltip-row" style={{ color: entry.color }}>
          <span className="value-chart-tooltip-dot" style={{ background: entry.color }} />
          {entry.name}: {formatCurrencyValue(entry.value, currency)}
        </p>
      ))}
    </div>
  );
}

export default function ValueOverTimeChart({ snapshots, currency }) {
  if (!snapshots || snapshots.length === 0) return null;

  // Build chart data: each snapshot date becomes a data point
  // with keys for 'total' and each cellar name
  const cellarNames = new Set();
  const hasMultipleCellars = snapshots.some(s => s.cellars?.length > 1);

  const data = snapshots.map(s => {
    const point = { date: formatDateLabel(s.date), totalValue: s.totalValue };
    if (hasMultipleCellars) {
      for (const c of (s.cellars || [])) {
        const name = c.name || 'Cellar';
        cellarNames.add(name);
        point[name] = c.value;
      }
    }
    return point;
  });

  const cellarList = [...cellarNames];

  return (
    <div className="value-chart-container">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 12, bottom: 0 }}>
          <CartesianGrid stroke="#252525" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tick={{ fill: '#9A9484', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: '#333' }}
          />
          <YAxis
            tick={{ fill: '#9A9484', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => formatCurrencyValue(v, currency)}
            width={80}
          />
          <Tooltip content={<CustomTooltip currency={currency} />} />
          {hasMultipleCellars && (
            <Legend
              wrapperStyle={{ fontSize: 11, color: '#9A9484', paddingTop: 8 }}
            />
          )}
          <Line
            type="monotone"
            dataKey="totalValue"
            name="Total"
            stroke="#7B9E88"
            strokeWidth={2.5}
            dot={data.length <= 12}
            activeDot={{ r: 4 }}
          />
          {hasMultipleCellars && cellarList.map((name, i) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              stroke={CELLAR_COLORS[i % CELLAR_COLORS.length]}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
