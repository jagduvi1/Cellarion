import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import worldData from 'world-atlas/countries-110m.json';
import { useAuth } from '../contexts/AuthContext';
import { NUM_TO_A2 } from '../utils/isoCountryCodes';
import { fromNormalized, formatRating, SCALE_META } from '../utils/ratingUtils';
import './Statistics.css';

// ── Color palette ─────────────────────────────────────────────────────────────
const TYPE_COLORS = {
  red:       '#C0504D',
  white:     '#D4C87A',
  'rosé':    '#E8A0B0',
  sparkling: '#6EC6C6',
  dessert:   '#D4A070',
  fortified: '#8B6A9A',
  unknown:   '#6a6a6a',
};

const TYPE_LABELS = {
  red: 'Red', white: 'White', 'rosé': 'Rosé',
  sparkling: 'Sparkling', dessert: 'Dessert', fortified: 'Fortified', unknown: 'Unknown',
};

const REASON_COLORS = {
  drank:  '#7B9E88',
  gifted: '#7aade0',
  sold:   '#D4A070',
  other:  '#9A9484',
};

const COUNTRY_COLORS = [
  '#7B9E88', '#6B8E7B', '#5B7E6B', '#4B6E5B', '#3B5E4B',
  '#6EC6C6', '#5EB6B6', '#4EA6A6', '#3E9696', '#2E8686',
  '#D4C87A', '#C4B86A', '#B4A85A', '#A4984A', '#94883A',
];

const GRAPE_COLORS = [
  '#C0504D', '#B0403D', '#A0302D', '#90201D', '#80100D',
  '#E8A0B0', '#D890A0', '#C88090', '#B87080', '#A86070',
  '#8B6A9A', '#7B5A8A', '#6B4A7A', '#5B3A6A', '#4B2A5A',
];

const GRADE_COLORS = { A: '#7B9E88', B: '#D4C87A', C: '#D4A070', D: '#C0504D', F: '#9A2020' };

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

/**
 * Format a normalized 0-100 rating for display in the user's preferred scale.
 * `targetScale` comes from overview.targetRatingScale (user's preference).
 */
function fmtRating(normalized, targetScale) {
  if (normalized == null) return '—';
  const scale = SCALE_META[targetScale] ? targetScale : '5';
  const converted = fromNormalized(normalized, scale);
  return formatRating(converted, scale);
}

function fmtCurrency(amount, currency) {
  if (!amount && amount !== 0) return '—';
  if (amount === 0) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${fmt(amount)}`;
  }
}

function fmtDays(days) {
  if (days === null || days === undefined) return '—';
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Today';
  return `${days}d left`;
}

// ── SVG Donut Chart ───────────────────────────────────────────────────────────
function DonutChart({ segments, total, size = 180 }) {
  const R  = size * 0.355;
  const C  = 2 * Math.PI * R;
  const cx = size / 2;
  const cy = size / 2;
  const validSegs = segments.filter(s => s.value > 0);
  let cumulative  = 0;

  return (
    <svg
      width={size} height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="donut-svg"
      role="img"
      aria-label={`Donut chart: ${total} total bottles`}
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
        fontSize={size * 0.07} fill="#9A9484">bottles</text>
    </svg>
  );
}

// ── Horizontal Bar Chart ──────────────────────────────────────────────────────
function HBarChart({ data, colors, maxItems = 12 }) {
  if (!data || data.length === 0) return <p className="stats-empty">No data yet</p>;
  const items  = data.slice(0, maxItems);
  const maxVal = Math.max(...items.map(d => d.count), 1);

  return (
    <div className="hbar-chart">
      {items.map((d, i) => (
        <div key={i} className="hbar-row">
          <span className="hbar-label" title={d.name}>{d.name}</span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{
              width: `${(d.count / maxVal) * 100}%`,
              background: Array.isArray(colors)
                ? (colors[i % colors.length] || '#7B9E88')
                : (colors || '#7B9E88'),
            }} />
          </div>
          <span className="hbar-count">{d.count}</span>
        </div>
      ))}
    </div>
  );
}

// ── Vintage Bar Chart (vertical) ──────────────────────────────────────────────
function VintageBarChart({ data }) {
  if (!data || data.length === 0) return <p className="stats-empty">No vintage data yet</p>;

  const numeric  = data.filter(d => d.year !== 'NV');
  const nvItem   = data.find(d => d.year === 'NV');
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const BAR_HEIGHT = 160;

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {numeric.map((d, i) => (
          <div key={i} className="vintage-bar-wrap"
            title={`${d.year}: ${d.count} bottle${d.count !== 1 ? 's' : ''}`}>
            <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
            <div className="vintage-bar"
              style={{ height: `${Math.max(4, (d.count / maxCount) * BAR_HEIGHT)}px` }} />
            <div className="vintage-bar-label">
              {numeric.length > 20 ? d.year.slice(-2) : d.year}
            </div>
          </div>
        ))}
        {nvItem && (
          <div className="vintage-bar-wrap vintage-bar-wrap--nv"
            title={`NV: ${nvItem.count} bottle${nvItem.count !== 1 ? 's' : ''}`}>
            <div className="vintage-bar-count">{nvItem.count}</div>
            <div className="vintage-bar vintage-bar--nv"
              style={{ height: `${Math.max(4, (nvItem.count / maxCount) * BAR_HEIGHT)}px` }} />
            <div className="vintage-bar-label">NV</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Rating Distribution ───────────────────────────────────────────────────────
// Bands are normalized 0-100 keys; labels show descriptive quality tier
const RATING_BANDS = [
  { key: '81-100', label: 'Excellent', sub: '4.1–5★ · 16–20/20 · 91–100pts', color: '#7B9E88' },
  { key: '61-80',  label: 'Very Good', sub: '3.1–4★ · 12–16/20 · 81–90pts',  color: '#D4C87A' },
  { key: '41-60',  label: 'Good',      sub: '2.1–3★ · 8–12/20 · 71–80pts',   color: '#D4A070' },
  { key: '21-40',  label: 'Fair',      sub: '1.1–2★ · 4–8/20 · 61–70pts',    color: '#C08050' },
  { key: '0-20',   label: 'Poor',      sub: '1★ · 1–4/20 · 50–60pts',        color: '#C0504D' },
];

function RatingChart({ byRating, avg, targetScale }) {
  const total  = Object.values(byRating).reduce((s, v) => s + v, 0);
  const maxVal = Math.max(...Object.values(byRating), 1);

  return (
    <div className="rating-chart">
      {RATING_BANDS.map(band => {
        const count = byRating[band.key] || 0;
        const pct   = total > 0 ? (count / total) * 100 : 0;
        return (
          <div key={band.key} className="rating-row" title={band.sub}>
            <span className="rating-stars" style={{ color: band.color, minWidth: 70, fontSize: '0.8rem' }}>{band.label}</span>
            <div className="rating-track">
              <div className="rating-fill" style={{ width: `${(count / maxVal) * 100}%`, background: band.color }} />
            </div>
            <span className="rating-count">{count}</span>
            <span className="rating-pct">{pct.toFixed(0)}%</span>
          </div>
        );
      })}
      {avg != null && (
        <div className="rating-avg">
          Average: <strong>{fmtRating(avg, targetScale)}</strong>
          {total > 0 && <span> across {total} rated bottle{total !== 1 ? 's' : ''}</span>}
        </div>
      )}
      {avg == null && total === 0 && <p className="stats-empty">No rated bottles yet</p>}
    </div>
  );
}

// ── Drink Window Visualization ────────────────────────────────────────────────
function DrinkWindowViz({ drinkWindow, windowCoverage, total }) {
  const segments = [
    { key: 'overdue',  label: 'Past Drink Window',    color: '#E07060', icon: '⚠' },
    { key: 'soon',     label: 'Drink Soon (≤90 days)', color: '#D4A070', icon: '⏱' },
    { key: 'inWindow', label: 'In Optimal Window',    color: '#7B9E88', icon: '✓' },
    { key: 'notReady', label: 'Not Ready Yet',         color: '#7aade0', icon: '◷' },
    { key: 'noWindow', label: 'No Dates Set',          color: '#3a3a3a', icon: '—' },
  ];

  const hasCoverage = windowCoverage && (windowCoverage.userSet + windowCoverage.sommSet) > 0;

  return (
    <div className="drink-window">
      <div className="drink-bar">
        {total > 0 ? segments.map(seg => {
          const count = drinkWindow[seg.key] || 0;
          const pct   = (count / total) * 100;
          if (pct === 0) return null;
          return (
            <div key={seg.key} className="drink-segment"
              style={{ width: `${pct}%`, background: seg.color }}
              title={`${seg.label}: ${count}`} />
          );
        }) : (
          <div className="drink-segment" style={{ width: '100%', background: '#252525' }} />
        )}
      </div>
      <div className="drink-legend">
        {segments.map(seg => {
          const count = drinkWindow[seg.key] || 0;
          return (
            <div key={seg.key} className="drink-legend-item">
              <span className="drink-legend-dot" style={{ background: seg.color }} />
              <span className="drink-legend-icon">{seg.icon}</span>
              <span className="drink-legend-label">{seg.label}</span>
              <span className="drink-legend-count"
                style={{ color: count > 0 && seg.key !== 'noWindow' ? seg.color : undefined }}>
                {count}
              </span>
            </div>
          );
        })}
      </div>
      {hasCoverage && (
        <div className="drink-coverage-note">
          Window source: {windowCoverage.userSet} set by you
          {windowCoverage.sommSet > 0 && ` · ${windowCoverage.sommSet} from sommelier profiles`}
          {windowCoverage.none > 0 && ` · ${windowCoverage.none} without data`}
        </div>
      )}
    </div>
  );
}

// ── Cellar Health Score ───────────────────────────────────────────────────────
function HealthScoreCard({ healthScore, healthGrade, drinkWindow }) {
  const score    = healthScore ?? 0;
  const gradeColor = healthGrade ? (GRADE_COLORS[healthGrade] || '#7B9E88') : '#555';
  const withWindow = drinkWindow.overdue + drinkWindow.soon + drinkWindow.inWindow + drinkWindow.notReady;

  return (
    <div className="health-card">
      <div className="health-gauge-wrap">
        <div className="health-gauge" style={{
          background: `conic-gradient(${gradeColor} 0% ${score}%, #252525 ${score}% 100%)`,
        }}>
          <div className="health-gauge-inner">
            <span className="health-grade" style={{ color: gradeColor }}>
              {healthGrade || '—'}
            </span>
            <span className="health-score-num">{healthScore !== null ? `${score}/100` : 'N/A'}</span>
          </div>
        </div>
      </div>
      <div className="health-breakdown">
        <div className="health-row">
          <span className="health-dot" style={{ background: '#7B9E88' }} />
          <span className="health-label">In optimal window</span>
          <span className="health-val">{drinkWindow.inWindow}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#7aade0' }} />
          <span className="health-label">Ageing nicely</span>
          <span className="health-val">{drinkWindow.notReady}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#D4A070' }} />
          <span className="health-label">Drink soon</span>
          <span className="health-val">{drinkWindow.soon}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#E07060' }} />
          <span className="health-label">Past window</span>
          <span className="health-val">{drinkWindow.overdue}</span>
        </div>
        {withWindow === 0 && (
          <p className="stats-empty" style={{ margin: '0.5rem 0 0' }}>
            Add drink window dates to see your score
          </p>
        )}
      </div>
    </div>
  );
}

// ── Regret Index ──────────────────────────────────────────────────────────────
function RegretIndexCard({ regretIndex, overdueCount, total }) {
  const level =
    regretIndex >= 30 ? 'critical' :
    regretIndex >= 15 ? 'warning'  :
    regretIndex > 0   ? 'mild'     : 'great';

  const messages = {
    critical: 'Many bottles past their prime. Open them — time is running out.',
    warning:  'Some bottles need attention. Plan a tasting soon.',
    mild:     'A few bottles slipping by. Stay on top of your cellar.',
    great:    'Excellent! Your cellar is well managed.',
  };

  const levelColors = {
    critical: '#E07060',
    warning:  '#D4A070',
    mild:     '#D4C87A',
    great:    '#7B9E88',
  };

  const color = levelColors[level];

  return (
    <div className="regret-card">
      <div className="regret-number" style={{ color }}>
        {regretIndex}%
      </div>
      <div className="regret-label">Regret Index</div>
      <div className="regret-desc">
        {overdueCount} bottle{overdueCount !== 1 ? 's' : ''} past their optimal drinking window,
        still unopened.
      </div>
      <div className="regret-message" style={{ borderLeftColor: color, color: '#E8DFD0' }}>
        {messages[level]}
      </div>
      {total > 0 && (
        <div className="regret-bar-wrap">
          <div className="regret-bar-track">
            <div
              className="regret-bar-fill"
              style={{ width: `${Math.min(100, regretIndex)}%`, background: color }}
            />
          </div>
          <span className="regret-bar-label">of windowed bottles</span>
        </div>
      )}
    </div>
  );
}

// ── Drink Window Forecast ─────────────────────────────────────────────────────
function DrinkForecastChart({ forecast }) {
  if (!forecast || forecast.length === 0) return <p className="stats-empty">No forecast data</p>;
  const maxCount = Math.max(...forecast.map(d => d.count), 1);
  const BAR_H    = 120;

  return (
    <div className="forecast-chart">
      {forecast.map((d, i) => (
        <div key={i} className={`forecast-col${d.isCurrent ? ' forecast-col--current' : ''}`}
          title={`${d.year}: ${d.count} bottle${d.count !== 1 ? 's' : ''} in window`}>
          <div className="forecast-count">{d.count > 0 ? d.count : ''}</div>
          <div className="forecast-bar"
            style={{ height: `${Math.max(d.count > 0 ? 4 : 0, (d.count / maxCount) * BAR_H)}px` }} />
          <div className="forecast-year">{d.year}</div>
          {d.isCurrent && <div className="forecast-now-label">now</div>}
        </div>
      ))}
    </div>
  );
}

// ── Urgency Ladder ────────────────────────────────────────────────────────────
function UrgencyLadder({ bottles, currency }) {
  if (!bottles || bottles.length === 0) {
    return (
      <p className="stats-empty">
        No bottles need urgent attention — your cellar is well timed!
      </p>
    );
  }

  return (
    <ol className="urgency-list">
      {bottles.map((b, i) => {
        const isOverdue = b.status === 'overdue';
        const color     = isOverdue ? '#E07060' : '#D4A070';
        return (
          <li key={i} className="urgency-item">
            <span className="urgency-rank" style={{ color }}>{i + 1}</span>
            <span className="urgency-type-dot"
              style={{ background: TYPE_COLORS[b.type] || '#7B9E88' }}
              title={TYPE_LABELS[b.type] || b.type} />
            <div className="urgency-info">
              <div className="urgency-name" title={b.name}>{b.name}</div>
              <div className="urgency-meta">
                {b.producer}{b.producer && b.vintage ? ' · ' : ''}{b.vintage}
                {b.source === 'somm' && <span className="urgency-source-badge">somm</span>}
              </div>
            </div>
            <div className="urgency-right">
              <span className="urgency-days" style={{ color }}>
                {isOverdue
                  ? `${Math.abs(b.daysRemaining || 0)}d ago`
                  : fmtDays(b.daysRemaining)}
              </span>
              {b.price && (
                <span className="urgency-price">{fmtCurrency(b.price, currency)}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Holding Time Chart ────────────────────────────────────────────────────────
function HoldingTimeChart({ holdingTime, targetScale }) {
  const hasData = holdingTime && holdingTime.some(d => d.count > 0);
  if (!hasData) {
    return (
      <p className="stats-empty">
        Mark bottles as consumed to see your patience profile.
      </p>
    );
  }
  const maxCount = Math.max(...holdingTime.map(d => d.count), 1);

  return (
    <div>
      <div className="holding-chart">
        {holdingTime.map((d, i) => (
          <div key={i} className="holding-row">
            <span className="holding-bucket">{d.bucket}</span>
            <div className="holding-track">
              <div className="holding-fill"
                style={{ width: `${(d.count / maxCount) * 100}%` }} />
            </div>
            <span className="holding-count">{d.count}</span>
            {d.avgConsumedRating != null && (
              <span className="holding-rating">
                {fmtRating(d.avgConsumedRating, targetScale)}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="holding-note">
        Higher ratings at longer holding times suggest aging is rewarding for your cellar.
      </p>
    </div>
  );
}

// ── Joy Per Dollar ────────────────────────────────────────────────────────────
function JoyPerDollarChart({ data, currency, targetScale }) {
  if (!data || data.length === 0) {
    return (
      <p className="stats-empty">
        Rate your consumed bottles to see which type gives you the most joy per {currency}.
      </p>
    );
  }
  const maxScore = Math.max(...data.map(d => d.score), 1);

  return (
    <div>
      <div className="jpd-chart">
        {data.map((d, i) => (
          <div key={i} className="jpd-row">
            <span className="jpd-dot"
              style={{ background: TYPE_COLORS[d.type] || '#7B9E88' }} />
            <span className="jpd-label">{TYPE_LABELS[d.type] || d.type}</span>
            <div className="jpd-track">
              <div className="jpd-fill"
                style={{
                  width:      `${(d.score / maxScore) * 100}%`,
                  background: TYPE_COLORS[d.type] || '#7B9E88',
                }} />
            </div>
            <div className="jpd-stats">
              <span className="jpd-rating">{fmtRating(d.avgRating, targetScale)}</span>
              <span className="jpd-price">avg {fmtCurrency(d.avgPrice, currency)}</span>
              <span className="jpd-count">{d.count} bottles</span>
            </div>
          </div>
        ))}
      </div>
      <p className="jpd-note">Score = enjoyment rating per {currency}1,000 spent. Higher = better value.</p>
    </div>
  );
}

// ── Regret Signal (expectation vs reality) ────────────────────────────────────
function RegretSignalCard({ regretSignal, targetScale }) {
  const { surprises, disappointments, avgDelta, count } = regretSignal;

  if (count === 0) {
    return (
      <p className="stats-empty">
        Rate bottles before and after drinking to track expectation vs reality.
      </p>
    );
  }

  return (
    <div className="regret-signal">
      {avgDelta !== null && (
        <div className="regret-signal-avg">
          Avg delta: <strong style={{ color: avgDelta >= 0 ? '#7B9E88' : '#E07060' }}>
            {avgDelta >= 0 ? '+' : ''}{fmtRating(Math.abs(avgDelta), targetScale)}
          </strong> across {count} bottle{count !== 1 ? 's' : ''}
        </div>
      )}
      <div className="regret-signal-cols">
        <div className="regret-signal-col">
          <div className="regret-signal-col-header regret-signal-col-header--good">
            🎉 Surprises
          </div>
          {surprises.length === 0
            ? <p className="stats-empty" style={{ margin: '0.5rem 0' }}>None yet</p>
            : surprises.map((b, i) => (
              <div key={i} className="regret-signal-item">
                <span className="rs-dot" style={{ background: TYPE_COLORS[b.type] || '#7B9E88' }} />
                <div className="rs-info">
                  <div className="rs-name">{b.name}</div>
                  <div className="rs-vintage">{b.vintage}</div>
                </div>
                <div className="rs-delta rs-delta--positive">+{fmtRating(b.delta, targetScale)}</div>
                <div className="rs-ratings">{fmtRating(b.rating, targetScale)} → {fmtRating(b.consumedRating, targetScale)}</div>
              </div>
            ))}
        </div>
        <div className="regret-signal-col">
          <div className="regret-signal-col-header regret-signal-col-header--bad">
            😬 Disappointments
          </div>
          {disappointments.length === 0
            ? <p className="stats-empty" style={{ margin: '0.5rem 0' }}>None yet</p>
            : disappointments.map((b, i) => (
              <div key={i} className="regret-signal-item">
                <span className="rs-dot" style={{ background: TYPE_COLORS[b.type] || '#7B9E88' }} />
                <div className="rs-info">
                  <div className="rs-name">{b.name}</div>
                  <div className="rs-vintage">{b.vintage}</div>
                </div>
                <div className="rs-delta rs-delta--negative">{fmtRating(b.delta, targetScale)}</div>
                <div className="rs-ratings">{fmtRating(b.rating, targetScale)} → {fmtRating(b.consumedRating, targetScale)}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ── Pace Card ─────────────────────────────────────────────────────────────────
function PaceCard({ pace, totalBottles }) {
  const { avgIntakePerYear, avgOutputPerYear, netPerYear, runway } = pace;
  const isGrowing    = netPerYear > 0;
  const isShrinking  = netPerYear < 0;
  const isBalanced   = netPerYear === 0;
  const netColor     = isGrowing ? '#7aade0' : isShrinking ? '#E07060' : '#9A9484';
  const netLabel     = isGrowing ? 'Growing' : isShrinking ? 'Shrinking' : 'Balanced';

  return (
    <div className="pace-card">
      <div className="pace-stats">
        <div className="pace-stat">
          <span className="pace-stat-value">{avgIntakePerYear}</span>
          <span className="pace-stat-label">bottles in / year</span>
        </div>
        <div className="pace-divider" />
        <div className="pace-stat">
          <span className="pace-stat-value">{avgOutputPerYear}</span>
          <span className="pace-stat-label">bottles out / year</span>
        </div>
        <div className="pace-divider" />
        <div className="pace-stat">
          <span className="pace-stat-value" style={{ color: netColor }}>
            {netPerYear > 0 ? '+' : ''}{netPerYear}
          </span>
          <span className="pace-stat-label" style={{ color: netColor }}>{netLabel}</span>
        </div>
      </div>
      {runway !== null && (
        <div className="pace-runway">
          <span className="pace-runway-num">{runway}</span>
          <span className="pace-runway-label">
            {runway === 1 ? 'year' : 'years'} of wine at current consumption
          </span>
        </div>
      )}
      {avgOutputPerYear === 0 && (
        <p className="stats-empty" style={{ marginTop: '0.75rem' }}>
          Consume bottles to see your cellar trajectory.
        </p>
      )}
    </div>
  );
}

// ── Consumption History (stacked bar) ────────────────────────────────────────
function ConsumptionChart({ consumptionByYear, consumptionByReason }) {
  if (!consumptionByYear || consumptionByYear.length === 0) {
    return (
      <p className="stats-empty">
        No consumption history yet — mark bottles as drank, gifted, or sold to see your history.
      </p>
    );
  }

  const reasons  = ['drank', 'gifted', 'sold', 'other'];
  const maxTotal = Math.max(
    ...consumptionByYear.map(d => reasons.reduce((s, r) => s + (d[r] || 0), 0)), 1
  );
  const BAR_H = 120;
  const total = Object.values(consumptionByReason).reduce((s, v) => s + v, 0);

  return (
    <div>
      <div className="consumption-chart">
        {consumptionByYear.map((d, i) => {
          const yearTotal = reasons.reduce((s, r) => s + (d[r] || 0), 0);
          return (
            <div key={i} className="consumption-year-col">
              <div className="consumption-bar-stack" style={{ height: `${BAR_H}px` }}
                title={`${d.year}: ${yearTotal} bottle${yearTotal !== 1 ? 's' : ''}`}>
                {reasons.map(r => {
                  const h = maxTotal > 0 ? ((d[r] || 0) / maxTotal) * BAR_H : 0;
                  if (h === 0) return null;
                  return (
                    <div key={r} className="consumption-segment"
                      style={{ height: `${h}px`, background: REASON_COLORS[r] }}
                      title={`${r}: ${d[r] || 0}`} />
                  );
                })}
              </div>
              <div className="consumption-year-label">{d.year}</div>
            </div>
          );
        })}
      </div>
      <div className="consumption-legend">
        {reasons.map(r => (
          <span key={r} className="consumption-legend-item">
            <span className="consumption-dot" style={{ background: REASON_COLORS[r] }} />
            {r.charAt(0).toUpperCase() + r.slice(1)}: {consumptionByReason[r] || 0}
          </span>
        ))}
      </div>
      <div className="consumption-totals">
        <strong>{total}</strong> total bottles consumed
      </div>
    </div>
  );
}

// ── Purchase History ──────────────────────────────────────────────────────────
function PurchaseHistoryChart({ byPurchaseYear }) {
  if (!byPurchaseYear || byPurchaseYear.length === 0) {
    return <p className="stats-empty">No purchase date data</p>;
  }
  const maxVal = Math.max(...byPurchaseYear.map(d => d.count), 1);
  const BAR_H  = 80;

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {byPurchaseYear.map((d, i) => (
          <div key={i} className="vintage-bar-wrap"
            title={`${d.year}: ${d.count} bottle${d.count !== 1 ? 's' : ''} purchased`}>
            <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
            <div className="vintage-bar"
              style={{
                height: `${Math.max(4, (d.count / maxVal) * BAR_H)}px`,
                background: 'linear-gradient(to top, #5f7a8a, #7aade0)',
              }} />
            <div className="vintage-bar-label">
              {byPurchaseYear.length > 15 ? d.year.slice(-2) : d.year}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Top Value Bottles ─────────────────────────────────────────────────────────
function TopValueList({ bottles, currency }) {
  if (!bottles || bottles.length === 0) {
    return <p className="stats-empty">Add prices to your bottles to see your most valuable wines.</p>;
  }

  return (
    <ol className="top-bottles-list">
      {bottles.map((b, i) => (
        <li key={i} className="top-bottle-item">
          <span className="top-bottle-rank" data-rank={i + 1}>#{i + 1}</span>
          <span className="top-bottle-type-dot"
            style={{ background: TYPE_COLORS[b.type] || '#7B9E88' }}
            title={TYPE_LABELS[b.type] || b.type} />
          <div className="top-bottle-info">
            <div className="top-bottle-name" title={b.name}>{b.name}</div>
            <div className="top-bottle-meta">
              {b.producer}{b.producer && b.vintage ? ' · ' : ''}{b.vintage}
            </div>
          </div>
          <span className="top-bottle-price" style={{ color: TYPE_COLORS[b.type] || '#7B9E88' }}>
            {fmtCurrency(b.price, currency)}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ── Cellar Breakdown ──────────────────────────────────────────────────────────
function CellarBreakdownViz({ cellars, currency }) {
  if (!cellars || cellars.length === 0) return <p className="stats-empty">No cellars found</p>;
  const maxCount = Math.max(...cellars.map(c => c.bottleCount), 1);

  return (
    <div className="cellar-breakdown">
      {cellars.map((c, i) => (
        <div key={i} className="cellar-breakdown-row">
          <div className="cellar-breakdown-header">
            <span className="cellar-breakdown-name">{c.name}</span>
            {c.value > 0 && (
              <span className="cellar-breakdown-value">{fmtCurrency(c.value, currency)}</span>
            )}
          </div>
          <div className="cellar-breakdown-track">
            <div className="cellar-breakdown-fill"
              style={{ width: `${(c.bottleCount / maxCount) * 100}%` }} />
          </div>
          <div className="cellar-breakdown-meta">
            <span>{c.bottleCount} bottle{c.bottleCount !== 1 ? 's' : ''}</span>
            <span>{c.uniqueWines} unique wine{c.uniqueWines !== 1 ? 's' : ''}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Bottle Size Chart ─────────────────────────────────────────────────────────
function BottleSizeChart({ byBottleSize }) {
  const entries = Object.entries(byBottleSize).sort((a, b) => b[1] - a[1]);
  if (entries.length <= 1) return null;
  const total      = entries.reduce((s, [, v]) => s + v, 0);
  const sizeColors = ['#7B9E88', '#6EC6C6', '#D4C87A', '#D4A070', '#8B6A9A'];

  return (
    <div className="hbar-chart">
      {entries.map(([size, count], i) => (
        <div key={size} className="hbar-row">
          <span className="hbar-label">{size}</span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{
              width: `${(count / total) * 100}%`,
              background: sizeColors[i % sizeColors.length],
            }} />
          </div>
          <span className="hbar-count">{count}</span>
          <span className="hbar-pct">{((count / total) * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}

// ── World Map ─────────────────────────────────────────────────────────────────
function getCountryFill(count, maxCount) {
  if (!count || count === 0) return '#161f1c';
  const t = maxCount > 1 ? Math.log(count) / Math.log(maxCount) : 1;
  // Interpolate rgb(38,61,50) → rgb(123,158,136)  (dark green → brand green)
  const r = Math.round(38  + t * (123 - 38));
  const g = Math.round(61  + t * (158 - 61));
  const b = Math.round(50  + t * (136 - 50));
  return `rgb(${r},${g},${b})`;
}

function WorldMapChart({ byCountry }) {
  const [hovered, setHovered] = useState(null);

  // Index by ISO alpha-2 for O(1) lookup during render
  const byCode = {};
  for (const c of byCountry) {
    if (c.code) byCode[c.code] = c;
  }

  const maxCount = byCountry.length > 0 ? Math.max(...byCountry.map(c => c.count)) : 1;
  const mappedCount  = byCountry.filter(c => c.code).length;
  const unmappedCount = byCountry.length - mappedCount;

  return (
    <div className="worldmap-wrap">
      {/* Hover info bar */}
      <div className="worldmap-info-bar">
        {hovered ? (
          <>
            <span className="worldmap-info-name">{hovered.name}</span>
            <span className="worldmap-info-count">
              {hovered.count} bottle{hovered.count !== 1 ? 's' : ''}
            </span>
          </>
        ) : (
          <span className="worldmap-info-hint">Hover a country to see details</span>
        )}
      </div>

      {/* Map */}
      <ComposableMap
        width={800}
        height={400}
        projection="geoEqualEarth"
        projectionConfig={{ scale: 155 }}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <Geographies geography={worldData}>
          {({ geographies }) =>
            geographies.map(geo => {
              const alpha2  = NUM_TO_A2[String(geo.id)];
              const data    = alpha2 ? byCode[alpha2] : null;
              const fill    = getCountryFill(data?.count, maxCount);
              const hasData = !!data;

              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill={fill}
                  stroke="#0a1512"
                  strokeWidth={0.35}
                  onMouseEnter={() => hasData && setHovered(data)}
                  onMouseLeave={() => setHovered(null)}
                  style={{
                    default: { outline: 'none', transition: 'fill 0.1s' },
                    hover:   { fill: hasData ? '#9bbfa8' : '#1e2e28', outline: 'none', cursor: 'default' },
                    pressed: { outline: 'none' },
                  }}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>

      {/* Legend */}
      <div className="worldmap-legend">
        <div className="worldmap-legend-scale">
          <span>1</span>
          <div className="worldmap-legend-gradient" />
          <span>{maxCount.toLocaleString()}</span>
          <span className="worldmap-legend-unit">bottles</span>
        </div>
        {unmappedCount > 0 && (
          <span className="worldmap-legend-note">
            {unmappedCount} countr{unmappedCount !== 1 ? 'ies' : 'y'} without ISO code hidden
          </span>
        )}
      </div>
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KPICard({ icon, label, value, sub, accentColor }) {
  return (
    <div className="kpi-card" style={accentColor ? { borderTopColor: accentColor } : {}}>
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ── Premium Upsell Gate ───────────────────────────────────────────────────────
function PremiumGate() {
  return (
    <div className="premium-gate">
      <div className="premium-gate-glow" />
      <div className="premium-gate-icon">📊</div>
      <h1>Collection Analytics</h1>
      <p className="premium-gate-sub">
        Deep insights into your entire wine collection — types, origins, vintages,
        value, drinking windows, consumption history, and more. The most comprehensive
        wine analytics dashboard available.
      </p>
      <div className="premium-gate-features">
        <div className="pgf-item"><span>🍷</span> Wine type &amp; origin breakdown</div>
        <div className="pgf-item"><span>📅</span> Vintage distribution by year</div>
        <div className="pgf-item"><span>💰</span> Collection value analysis</div>
        <div className="pgf-item"><span>⏱</span> Drinking window forecast</div>
        <div className="pgf-item"><span>🎯</span> Cellar health score</div>
        <div className="pgf-item"><span>😬</span> Regret Index — bottles past their prime</div>
        <div className="pgf-item"><span>🚨</span> Urgency ladder — drink these now</div>
        <div className="pgf-item"><span>💎</span> Joy Per Dollar — best bang for your buck</div>
      </div>
      <Link to="/plans" className="btn btn-primary premium-gate-btn">
        Upgrade to Premium
      </Link>
      <p className="premium-gate-trial">
        Not sure yet? <Link to="/plans">Start a free 30-day trial</Link>
      </p>
    </div>
  );
}

// ── Upgrade Card (inline upsell for locked sections) ─────────────────────────
function UpgradeCard({ plan = 'basic', features = [], fullWidth = false }) {
  const isPremiumCard = plan === 'premium';
  const label  = isPremiumCard ? 'Premium' : 'Basic';
  const color  = isPremiumCard ? '#7B5A8A' : '#4a8a9a';
  const badge  = isPremiumCard ? '★ Premium' : 'Basic';

  return (
    <div className={`stats-card upgrade-card upgrade-card--${plan}${fullWidth ? ' stats-card--full' : ''}`}>
      <div className="upgrade-card-inner">
        <div className="upgrade-card-header">
          <span className="upgrade-card-icon">🔒</span>
          <span className="upgrade-card-badge" style={{ color }}>{badge}</span>
        </div>
        <p className="upgrade-card-tagline">Unlock with {label}</p>
        {features.length > 0 && (
          <div className="upgrade-card-features">
            {features.map((f, i) => (
              <span key={i} className="upgrade-card-feature">{f}</span>
            ))}
          </div>
        )}
        <Link to="/plans" className="btn upgrade-card-btn" style={{ borderColor: color, color }}>
          Upgrade to {label}
        </Link>
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────
function EmptyCollection() {
  return (
    <div className="stats-empty-state">
      <div className="stats-empty-icon">🍾</div>
      <h2>Your cellar is empty</h2>
      <p>Add bottles to your cellars to see your analytics.</p>
      <Link to="/cellars" className="btn btn-primary">Go to My Cellars</Link>
    </div>
  );
}

// ── Main Statistics Page ──────────────────────────────────────────────────────
function Statistics() {
  const { user, apiFetch } = useAuth();
  const [stats, setStats]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]  = useState(null);

  const planExpired   = user?.planExpiresAt && Date.now() > new Date(user.planExpiresAt).getTime();
  const effectivePlan = planExpired ? 'free' : (user?.plan || 'free');
  const isBasic       = effectivePlan === 'basic' || effectivePlan === 'premium';
  const isPremium     = effectivePlan === 'premium';

  const load = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/stats/overview');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load statistics');
      setStats(data.stats);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="stats-page stats-loading">
        <div className="stats-spinner" />
        <p>Analysing your collection…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="stats-page">
        <div className="alert alert-error">{error}</div>
      </div>
    );
  }

  if (!stats) return null;

  const {
    overview, byType, byCountry, byRegion, byGrape,
    byVintage, byRating, byBottleSize, byPurchaseYear,
    drinkWindow, windowCoverage, topValueBottles,
    consumptionByYear, consumptionByReason, cellarBreakdown,
    drinkWindowForecast, urgencyLadder, holdingTime,
    joyPerDollar, regretSignal, pace, topProducers,
  } = stats;

  if (overview.totalBottles === 0 && overview.totalConsumed === 0) {
    return <div className="stats-page"><EmptyCollection /></div>;
  }

  const typeSegments = Object.entries(byType)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, value]) => ({
      type, label: TYPE_LABELS[type] || type,
      value, color: TYPE_COLORS[type] || '#6a6a6a',
    }));

  const total          = overview.totalBottles;
  const currency       = overview.currency;
  const targetScale    = overview.targetRatingScale || '5';
  const hasConsumption = overview.totalConsumed > 0;
  const hasMultipleSizes = Object.keys(byBottleSize).length > 1;
  const hasPurchaseDates = byPurchaseYear && byPurchaseYear.length > 0;
  const hasUrgency     = urgencyLadder && urgencyLadder.length > 0;
  const hasForecast    = drinkWindowForecast && drinkWindowForecast.some(d => d.count > 0);
  const hasProducers   = topProducers && topProducers.length > 0;

  const PREMIUM_FEATURES = [
    '🎯 Cellar health score & grade',
    '😬 Regret Index — bottles past prime',
    '🚨 Urgency ladder — drink these now',
    '🔭 Drink window forecast by year',
    '⏳ Patience Payoff — does aging reward you?',
    '💎 Joy Per Dollar — best value wines',
    '🤯 Expectation vs Reality',
    '💰 Collection value & most valuable bottles',
  ];

  return (
    <div className="stats-page">

      {/* ── Header ── */}
      <div className="stats-header">
        <div>
          <h1 className="stats-title">Collection Analytics</h1>
          <p className="stats-subtitle">
            {isBasic
              ? `Complete insights across ${overview.totalCellars} cellar${overview.totalCellars !== 1 ? 's' : ''}${overview.totalCountries > 0 ? ` · ${overview.totalCountries} countries · ${overview.totalGrapes} grape varieties` : ''}`
              : 'Your collection at a glance'
            }
          </p>
        </div>
        {isPremium
          ? <span className="stats-plan-badge stats-plan-badge--premium">★ Premium</span>
          : isBasic
            ? <span className="stats-plan-badge stats-plan-badge--basic">Basic</span>
            : null
        }
      </div>

      {/* ── Primary KPIs ── */}
      <div className={`kpi-grid${isPremium ? '' : isBasic ? ' kpi-grid--5' : ' kpi-grid--3'}`}>
        <KPICard icon="🍾" label="Active Bottles" value={fmt(total)}
          sub={`${fmt(overview.uniqueWines)} unique wines`} accentColor="#7B9E88" />
        <KPICard icon="🌍" label="Countries" value={fmt(overview.totalCountries)}
          sub={`${fmt(overview.totalGrapes)} grape varieties`} accentColor="#6EC6C6" />
        <KPICard icon="⭐" label="Avg Rating"
          value={overview.avgRating != null ? fmtRating(overview.avgRating, targetScale) : '—'}
          accentColor="#D4C87A" />
        {isBasic && (
          <KPICard icon="📅" label="Avg Vintage Age"
            value={overview.avgVintageAge ? `${overview.avgVintageAge} yrs` : '—'}
            sub={overview.oldestVintage
              ? `${overview.oldestVintage} → ${overview.newestVintage}` : undefined}
            accentColor="#8B6A9A" />
        )}
        {isBasic && (
          <KPICard icon="⏱" label="Drink Soon / Overdue"
            value={`${drinkWindow.soon + drinkWindow.overdue}`}
            sub={drinkWindow.overdue > 0
              ? `${drinkWindow.overdue} past window`
              : `${drinkWindow.inWindow} in window`}
            accentColor={drinkWindow.overdue > 0 ? '#E07060' : '#7B9E88'} />
        )}
        {isPremium && (
          <KPICard icon="💰" label="Est. Collection Value"
            value={overview.totalValue > 0 ? fmtCurrency(overview.totalValue, currency) : '—'}
            sub={overview.avgPrice > 0
              ? `avg ${fmtCurrency(overview.avgPrice, currency)} / bottle` : undefined}
            accentColor="#D4A070" />
        )}
      </div>

      {/* ── Secondary KPIs (consumption) — basic+ only ── */}
      {isBasic && hasConsumption && (
        <div className="kpi-grid kpi-grid--secondary">
          <KPICard icon="✓" label="Total Consumed" value={fmt(overview.totalConsumed)} />
          <KPICard icon="🥂" label="Bottles Drunk"  value={fmt(overview.bottlesDrunk)} />
          <KPICard icon="🎁" label="Gifted"          value={fmt(overview.bottlesGifted)} />
          <KPICard icon="💵" label="Sold"            value={fmt(overview.bottlesSold)} />
          {overview.avgConsumedRating != null && (
            <KPICard icon="🌟" label="Avg Consumed Rating"
              value={fmtRating(overview.avgConsumedRating, targetScale)} />
          )}
        </div>
      )}

      {/* ── Health + Regret row — premium only ── */}
      {isPremium && (
        <div className="stats-grid stats-grid--insight">
          <div className="stats-card">
            <h2 className="stats-card-title">
              Cellar Health Score
              <span className="stats-card-title-note">How well-timed is your collection?</span>
            </h2>
            <HealthScoreCard
              healthScore={overview.healthScore}
              healthGrade={overview.healthGrade}
              drinkWindow={drinkWindow}
            />
          </div>
          <div className={`stats-card stats-card--regret${overview.regretIndex >= 15 ? ' stats-card--regret-alert' : ''}`}>
            <h2 className="stats-card-title">
              Regret Index
              <span className="stats-card-title-note">Bottles past their prime, still unopened</span>
            </h2>
            <RegretIndexCard
              regretIndex={overview.regretIndex}
              overdueCount={drinkWindow.overdue}
              total={total}
            />
          </div>
        </div>
      )}

      {/* ── Main Grid ── */}
      <div className="stats-grid">

        {/* Wine Types Donut — FREE+ */}
        <div className="stats-card">
          <h2 className="stats-card-title">Wine Types</h2>
          {total > 0 ? (
            <div className="donut-layout">
              <DonutChart segments={typeSegments} total={total} size={180} />
              <div className="donut-legend">
                {typeSegments.map(seg => (
                  <div key={seg.type} className="donut-legend-item">
                    <span className="donut-legend-dot" style={{ background: seg.color }} />
                    <span className="donut-legend-label">{seg.label}</span>
                    <span className="donut-legend-count">{seg.value}</span>
                    <span className="donut-legend-pct">
                      ({total > 0 ? ((seg.value / total) * 100).toFixed(0) : 0}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="stats-empty">No bottles yet</p>
          )}
        </div>

        {/* Drinking Windows (basic+) or Top 5 Origins (free) */}
        {isBasic ? (
          <div className="stats-card">
            <h2 className="stats-card-title">Drinking Windows</h2>
            <DrinkWindowViz drinkWindow={drinkWindow} windowCoverage={windowCoverage} total={total} />
          </div>
        ) : (
          <div className="stats-card">
            <h2 className="stats-card-title">
              Top Origins
              <span className="stats-card-title-note">Top 5</span>
            </h2>
            <HBarChart data={byCountry} colors={COUNTRY_COLORS} maxItems={5} />
          </div>
        )}

        {/* Vintage Distribution — BASIC+ */}
        {isBasic && (
          <div className="stats-card stats-card--full">
            <h2 className="stats-card-title">
              Vintage Distribution
              {overview.oldestVintage && (
                <span className="stats-card-title-note">
                  {overview.oldestVintage} – {overview.newestVintage}
                </span>
              )}
            </h2>
            <VintageBarChart data={byVintage} />
          </div>
        )}

        {/* Upgrade cards — FREE users only */}
        {!isBasic && (
          <>
            <UpgradeCard plan="basic" fullWidth features={[
              '📅 Vintage distribution chart',
              '🗺️ World origins map',
              '🍇 Top grapes & regions',
              '⭐ Rating breakdown',
              '⏱ Drinking window status',
              '📈 Consumption history',
              '🏃 Cellar pace tracker',
              '🏠 Cellar breakdown',
            ]} />
            <UpgradeCard plan="premium" fullWidth features={PREMIUM_FEATURES} />
          </>
        )}

        {/* ── BASIC+ sections ── */}
        {isBasic && (
          <>
            {/* World Map — BASIC */}
            <div className="stats-card stats-card--full">
              <h2 className="stats-card-title">
                Collection Origins
                <span className="stats-card-title-note">Darker = more bottles</span>
              </h2>
              <WorldMapChart byCountry={byCountry} />
            </div>

            {/* Top Origins — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">Top Origins</h2>
              <HBarChart data={byCountry} colors={COUNTRY_COLORS} />
            </div>

            {/* Top Grape Varieties — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">Top Grape Varieties</h2>
              <HBarChart data={byGrape} colors={GRAPE_COLORS} />
            </div>

            {/* Top Regions — BASIC */}
            {byRegion && byRegion.length > 0 && (
              <div className="stats-card">
                <h2 className="stats-card-title">Top Regions</h2>
                <HBarChart data={byRegion}
                  colors={['#7aade0', '#6a9dd0', '#5a8dc0', '#4a7db0', '#3a6da0']} />
              </div>
            )}

            {/* Top Producers — BASIC */}
            {hasProducers && (
              <div className="stats-card">
                <h2 className="stats-card-title">Top Producers</h2>
                <HBarChart data={topProducers}
                  colors={['#D4A070', '#C4906A', '#B48064', '#A4705E', '#946058']} />
              </div>
            )}

            {/* Rating Distribution — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">Rating Distribution</h2>
              <RatingChart byRating={byRating} avg={overview.avgRating} targetScale={targetScale} />
            </div>

            {/* Bottle Sizes — BASIC */}
            {hasMultipleSizes && (
              <div className="stats-card">
                <h2 className="stats-card-title">Bottle Sizes</h2>
                <BottleSizeChart byBottleSize={byBottleSize} />
              </div>
            )}

            {/* Purchase History — BASIC */}
            {hasPurchaseDates && (
              <div className="stats-card">
                <h2 className="stats-card-title">Purchases by Year</h2>
                <PurchaseHistoryChart byPurchaseYear={byPurchaseYear} />
              </div>
            )}

            {/* Pace — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">
                Cellar Pace &amp; Trajectory
                <span className="stats-card-title-note">Intake vs consumption rate</span>
              </h2>
              <PaceCard pace={pace} totalBottles={total} />
            </div>

            {/* Consumption History — BASIC */}
            <div className="stats-card stats-card--full">
              <h2 className="stats-card-title">Consumption History</h2>
              <ConsumptionChart
                consumptionByYear={consumptionByYear}
                consumptionByReason={consumptionByReason}
              />
            </div>

            {/* Cellar Breakdown — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">Cellar Breakdown</h2>
              <CellarBreakdownViz cellars={cellarBreakdown} currency={currency} />
            </div>

            {/* Premium upgrade for basic users OR premium-only content */}
            {!isPremium ? (
              <UpgradeCard plan="premium" fullWidth features={PREMIUM_FEATURES} />
            ) : (
              <>
                {/* Drink Window Forecast — PREMIUM */}
                {hasForecast && (
                  <div className="stats-card stats-card--full">
                    <h2 className="stats-card-title">
                      Drink Window Forecast
                      <span className="stats-card-title-note">Bottles in window by year</span>
                    </h2>
                    <DrinkForecastChart forecast={drinkWindowForecast} />
                  </div>
                )}

                {/* Urgency Ladder — PREMIUM */}
                {hasUrgency && (
                  <div className="stats-card stats-card--full">
                    <h2 className="stats-card-title">
                      Drink These Now
                      <span className="stats-card-title-note">Ordered by urgency</span>
                    </h2>
                    <UrgencyLadder bottles={urgencyLadder} currency={currency} />
                  </div>
                )}

                {/* Holding Time — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">
                    Patience Payoff
                    <span className="stats-card-title-note">Does aging reward you?</span>
                  </h2>
                  <HoldingTimeChart holdingTime={holdingTime} targetScale={targetScale} />
                </div>

                {/* Joy Per Dollar — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">
                    Joy Per {currency}
                    <span className="stats-card-title-note">Rating vs price by type</span>
                  </h2>
                  <JoyPerDollarChart data={joyPerDollar} currency={currency} targetScale={targetScale} />
                </div>

                {/* Regret Signal — PREMIUM */}
                {hasConsumption && (
                  <div className="stats-card stats-card--full">
                    <h2 className="stats-card-title">
                      Expectation vs Reality
                      <span className="stats-card-title-note">When wines surprised or disappointed you</span>
                    </h2>
                    <RegretSignalCard regretSignal={regretSignal} targetScale={targetScale} />
                  </div>
                )}

                {/* Most Valuable Bottles — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">Most Valuable Bottles</h2>
                  <TopValueList bottles={topValueBottles} currency={currency} />
                </div>
              </>
            )}
          </>
        )}

      </div>

      <p className="stats-footnote">
        Active bottles only ·{' '}
        {isPremium && `Prices converted using today's exchange rates to ${currency} · `}
        Drink windows use your personal dates where set, falling back to sommelier profiles ·
        Only your owned cellars are included
      </p>
    </div>
  );
}

export default Statistics;
