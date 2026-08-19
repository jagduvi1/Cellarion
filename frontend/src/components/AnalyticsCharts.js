import React, { useMemo } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { SERIES_COLORS } from '../utils/chartColors';

/**
 * Charts over the analytics grouped result (#987 R-C, first slice).
 *
 * Pure presentation: the grouped response IS the chart data — every number
 * here came through the engine's caps and normalizations, so nothing is
 * computed client-side beyond pivoting the bucket list into recharts' shape.
 * Colors come from the app-wide SERIES_COLORS palette (one definition for
 * every chart in the app — the palette-unification decision, D1/R-C).
 *
 * Shapes: 1 dimension → bar | donut | line; 2 dimensions → stacked bar
 * (dim1 on the axis, dim2 as the stack segments, capped for legibility).
 */

const STACK_SERIES_CAP = 10;
const OTHER = '…other';

function pivotStacked(buckets, measureIndex) {
  // buckets: [{dimensions: [d1, d2], measures: [...]}] → rows keyed by d1
  // with one property per d2 series. Series beyond the cap fold into OTHER.
  const seriesTotals = new Map();
  for (const b of buckets) {
    const s = String(b.dimensions[1] ?? '—');
    seriesTotals.set(s, (seriesTotals.get(s) || 0) + (b.measures[measureIndex] || 0));
  }
  const keep = new Set([...seriesTotals.entries()]
    .sort((a, z) => z[1] - a[1])
    .slice(0, STACK_SERIES_CAP)
    .map(([k]) => k));
  const rows = new Map();
  for (const b of buckets) {
    const x = String(b.dimensions[0] ?? '—');
    const rawS = String(b.dimensions[1] ?? '—');
    const s = keep.has(rawS) ? rawS : OTHER;
    if (!rows.has(x)) rows.set(x, { name: x });
    const row = rows.get(x);
    row[s] = (row[s] || 0) + (b.measures[measureIndex] ?? 0);
  }
  const series = [...keep, ...(keep.size < seriesTotals.size ? [OTHER] : [])];
  return { rows: [...rows.values()], series };
}

export default function AnalyticsCharts({ data, chartType, measureIndex }) {
  const mi = Math.min(measureIndex, data.measureLabels.length - 1);
  const twoDims = data.dimensionKeys.length === 2;

  const flat = useMemo(() => data.buckets.map((b) => ({
    name: String(b.dimensions[0] ?? '—'),
    value: b.measures[mi] ?? 0,
  })), [data, mi]);

  const stacked = useMemo(
    () => (twoDims ? pivotStacked(data.buckets, mi) : null),
    [data, mi, twoDims]
  );

  const sortedFlat = useMemo(
    () => [...flat].sort((a, z) => a.name.localeCompare(z.name, undefined, { numeric: true })),
    [flat]
  );

  const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

  if (chartType === 'donut' && !twoDims) {
    return (
      <div className="at-chart">
        <ResponsiveContainer width="100%" height={320}>
          <PieChart>
            <Pie data={flat} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={1}>
              {flat.map((_, i) => <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={round} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chartType === 'line' && !twoDims) {
    return (
      <div className="at-chart">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={sortedFlat} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={48} />
            <Tooltip formatter={round} />
            <Line type="monotone" dataKey="value" name={data.measureLabels[mi]} stroke={SERIES_COLORS[0]} dot={{ r: 2 }} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (twoDims && stacked) {
    return (
      <div className="at-chart">
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={stacked.rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={48} />
            <Tooltip formatter={round} />
            <Legend />
            {stacked.series.map((s, i) => (
              <Bar key={s} dataKey={s} stackId="a" fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="at-chart">
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={flat} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} width={48} />
          <Tooltip formatter={round} />
          <Bar dataKey="value" name={data.measureLabels[mi]} fill={SERIES_COLORS[0]} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
