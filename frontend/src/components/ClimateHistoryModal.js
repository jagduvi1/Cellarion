import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import { useAuth } from '../contexts/AuthContext';
import Modal from './Modal';
import { getCellarClimateReadings } from '../api/climate';

// Same fixed categorical order as ValueOverTimeChart — series keep their hue
// when the range changes because assignment follows the sorted series list,
// never the visible count.
const SERIES_COLORS = [
  '#C0504D', '#D4C87A', '#E8A0B0', '#6EC6C6', '#D4A070',
  '#8B6A9A', '#5B8DB8', '#A03648', '#946333', '#3B6D98',
];
// Threshold guides are recessive ink, not a series or status color.
const THRESHOLD_STROKE = '#8a8474';

const RANGES = ['24h', '7d', '30d', '1y'];

function formatTick(t, range) {
  const d = new Date(t);
  if (range === '24h') return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (range === '1y') return d.toLocaleDateString(undefined, { month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="value-chart-tooltip">
      <p className="value-chart-tooltip-date">{new Date(label).toLocaleString()}</p>
      {payload.map((entry, i) => (
        <p key={i} className="value-chart-tooltip-row" style={{ color: entry.color }}>
          <span className="value-chart-tooltip-dot" style={{ background: entry.color }} />
          {entry.name}: {entry.value != null ? `${entry.value} ${unit}` : '—'}
        </p>
      ))}
    </div>
  );
}

// Merge the API's per-series points into one row per time bucket (buckets are
// server-aligned via $dateTrunc, so timestamps match across series exactly).
function buildChartData(seriesList) {
  const rows = new Map();
  for (const s of seriesList) {
    for (const p of s.points) {
      const t = new Date(p.t).getTime();
      let row = rows.get(t);
      if (!row) { row = { t }; rows.set(t, row); }
      row[s.seriesKey] = p.avg;
    }
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

function ClimateChart({ title, seriesList, range, unit, thresholds }) {
  const data = buildChartData(seriesList);
  if (data.length === 0) return null;
  const showLegend = seriesList.length >= 2;

  return (
    <>
      <p className="climate-history-chart-title">{title}</p>
      <ResponsiveContainer width="100%" height={230}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#252525" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t) => formatTick(t, range)}
            tick={{ fill: '#9A9484', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: '#333' }}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#9A9484', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip content={<ChartTooltip unit={unit} />} />
          {showLegend && <Legend wrapperStyle={{ fontSize: 11, color: '#9A9484', paddingTop: 8 }} />}
          {thresholds.map(th => (
            <ReferenceLine
              key={th.label}
              y={th.value}
              stroke={THRESHOLD_STROKE}
              strokeDasharray="6 4"
              ifOverflow="extendDomain"
              label={{ value: th.label, fill: '#9A9484', fontSize: 10, position: 'insideTopRight' }}
            />
          ))}
          {seriesList.map((s, i) => (
            <Line
              key={s.seriesKey}
              type="monotone"
              dataKey={s.seriesKey}
              name={s.name}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

// Cellar climate history: one chart per measure (temperature / humidity —
// separate axes by design, never dual-axis), bucketed server-side, with the
// alert thresholds drawn as recessive guides.
function ClimateHistoryModal({ cellarId, config, channelLabels = {}, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const [range, setRange] = useState('24h');
  const [series, setSeries] = useState(null); // null = loading

  const load = useCallback(async (r) => {
    setSeries(null);
    try {
      const res = await getCellarClimateReadings(apiFetch, cellarId, r);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSeries(data.series || []);
    } catch {
      setSeries([]);
    }
  }, [apiFetch, cellarId]);

  useEffect(() => { load(range); }, [load, range]);

  // Stable series identity + display name. Sorted so color assignment follows
  // the entity, not the visible order in this particular response.
  const prepared = (series || [])
    .map(s => ({
      ...s,
      seriesKey: `${s.deviceId}:${s.channel}:${s.type}`,
      name: channelLabels[`${s.deviceId}:${s.channel}:${s.type}`] || s.channel,
    }))
    .sort((a, b) => a.seriesKey.localeCompare(b.seriesKey));
  // Disambiguate identical names coming from different devices.
  const nameCounts = prepared.reduce((acc, s) => { acc[s.name] = (acc[s.name] || 0) + 1; return acc; }, {});
  for (const s of prepared) {
    if (nameCounts[s.name] > 1 && s.deviceName) s.name = `${s.name} (${s.deviceName})`;
  }
  const tempSeries = prepared.filter(s => s.type === 'temperature');
  const rhSeries = prepared.filter(s => s.type === 'humidity');

  return (
    <Modal title={t('climate.historyTitle')} onClose={onClose} showClose wide>
      <div className="climate-history-ranges" role="group">
        {RANGES.map(r => (
          <button
            key={r}
            type="button"
            className={`btn btn-small ${range === r ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setRange(r)}
          >
            {t(`climate.range${r}`)}
          </button>
        ))}
      </div>

      {series === null ? (
        <p className="settings-hint">…</p>
      ) : prepared.length === 0 ? (
        <p className="settings-hint">{t('climate.noData')}</p>
      ) : (
        <>
          <ClimateChart
            title={t('climate.tempChart')}
            seriesList={tempSeries}
            range={range}
            unit="°C"
            thresholds={[
              { value: config.tempMin, label: 'min' },
              { value: config.tempMax, label: 'max' },
            ]}
          />
          <ClimateChart
            title={t('climate.rhChart')}
            seriesList={rhSeries}
            range={range}
            unit="%"
            thresholds={[
              { value: config.rhMin, label: 'min' },
              { value: config.rhMax, label: 'max' },
            ]}
          />
        </>
      )}
    </Modal>
  );
}

export default ClimateHistoryModal;
