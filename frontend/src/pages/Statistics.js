import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import worldData from 'world-atlas/countries-110m.json';
import { useAuth } from '../contexts/AuthContext';
import { NUM_TO_A2 } from '../utils/isoCountryCodes';
import { fromNormalized, formatRating, formatDelta, SCALE_META } from '../utils/ratingUtils';
import { getValueHistory } from '../api/stats';
import ValueOverTimeChart from '../components/ValueOverTimeChart';
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

const REASON_COLORS = {
  drank:  '#7A1E2D',
  gifted: '#5B8DB8',
  sold:   '#D4A373',
  other:  '#8A8580',
};

const COUNTRY_COLORS = [
  '#7A1E2D', '#8C2A3A', '#A03648', '#621826', '#4D1220',
  '#D4A373', '#C49363', '#B48353', '#A47343', '#946333',
  '#5B8DB8', '#4B7DA8', '#3B6D98', '#2B5D88', '#1B4D78',
];

const GRAPE_COLORS = [
  '#C0504D', '#B0403D', '#A0302D', '#90201D', '#80100D',
  '#E8A0B0', '#D890A0', '#C88090', '#B87080', '#A86070',
  '#8B6A9A', '#7B5A8A', '#6B4A7A', '#5B3A6A', '#4B2A5A',
];

const GRADE_COLORS = { A: '#2D7A45', B: '#D4C87A', C: '#D4A373', D: '#C0504D', F: '#9A2020' };

const RATING_BAND_DEFS = [
  { key: '81-100', labelKey: 'excellent', color: '#7A1E2D' },
  { key: '61-80',  labelKey: 'veryGood', color: '#D4C87A' },
  { key: '41-60',  labelKey: 'good',      color: '#D4A070' },
  { key: '21-40',  labelKey: 'fair',      color: '#C08050' },
  { key: '0-20',   labelKey: 'poor',      color: '#C0504D' },
];

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

/**
 * Format a normalized delta for display in the user's preferred scale.
 * Uses formatDelta (no floor offset) rather than fromNormalized.
 */
function fmtDelta(normalizedDelta, targetScale) {
  if (normalizedDelta == null) return '—';
  const scale = SCALE_META[targetScale] ? targetScale : '5';
  return formatDelta(normalizedDelta, scale);
}

/**
 * Return a tooltip string for a rating band in the user's preferred scale.
 * E.g. bandSub('81-100', '100') → "91–100pts"
 */
function bandSub(bandKey, targetScale) {
  const scale = SCALE_META[targetScale] ? targetScale : '5';
  const [lo, hi] = bandKey.split('-').map(Number);
  const meta = SCALE_META[scale];
  const prec = meta.step < 1 ? 1 : 0;
  const loVal = fromNormalized(lo, scale);
  const hiVal = fromNormalized(hi, scale);
  return `${loVal.toFixed(prec)}–${hiVal.toFixed(prec)}${meta.suffix}`;
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

function fmtDays(days, t) {
  if (days === null || days === undefined) return '—';
  if (days < 0) return t('statistics.days.overdue', { count: Math.abs(days) });
  if (days === 0) return t('statistics.days.today');
  return t('statistics.days.left', { count: days });
}

// ── SVG Donut Chart ───────────────────────────────────────────────────────────
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

// ── Horizontal Bar Chart ──────────────────────────────────────────────────────
function HBarChart({ data, colors, maxItems = 12 }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) return <p className="stats-empty">{t('statistics.noDataYet')}</p>;
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
                ? (colors[i % colors.length] || '#7A1E2D')
                : (colors || '#7A1E2D'),
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
  const { t } = useTranslation();
  if (!data || data.length === 0) return <p className="stats-empty">{t('statistics.noVintageData')}</p>;

  const numeric  = data.filter(d => d.year !== 'NV');
  const nvItem   = data.find(d => d.year === 'NV');
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const BAR_HEIGHT = 160;

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {numeric.map((d, i) => (
          <div key={i} className="vintage-bar-wrap"
            title={t('statistics.vintageBottle', { vintage: d.year, count: d.count })}>
            <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
            <div className="vintage-bar"
              style={{ height: `${Math.max(4, (d.count / maxCount) * BAR_HEIGHT)}px` }} />
            <div className="vintage-bar-label">
              {numeric.length > 20 ? String(d.year).slice(-2) : d.year}
            </div>
          </div>
        ))}
        {nvItem && (
          <div className="vintage-bar-wrap vintage-bar-wrap--nv"
            title={t('statistics.vintageBottle', { vintage: 'NV', count: nvItem.count })}>
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
function RatingChart({ byRating, avg, targetScale }) {
  const { t } = useTranslation();
  const total  = Object.values(byRating).reduce((s, v) => s + v, 0);
  const maxVal = Math.max(...Object.values(byRating), 1);

  return (
    <div className="rating-chart">
      {RATING_BAND_DEFS.map(band => {
        const count = byRating[band.key] || 0;
        const pct   = total > 0 ? (count / total) * 100 : 0;
        return (
          <div key={band.key} className="rating-row" title={bandSub(band.key, targetScale)}>
            <span className="rating-stars" style={{ color: band.color }}>
              {t(`statistics.ratingBands.${band.labelKey}`)}
            </span>
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
          {t('statistics.rating.average')} <strong>{fmtRating(avg, targetScale)}</strong>
          {total > 0 && <span> {t('statistics.rating.acrossBottles', { count: total })}</span>}
        </div>
      )}
      {avg == null && total === 0 && <p className="stats-empty">{t('statistics.noRatedBottles')}</p>}
    </div>
  );
}

// ── Maturity Visualization ────────────────────────────────────────────────────
function MaturityViz({ maturity, maturityCoverage, total }) {
  const { t } = useTranslation();
  const segments = [
    { key: 'declining',  color: '#C94040', icon: '⚠' },
    { key: 'late',       color: '#D4A070', icon: '⏱' },
    { key: 'peak',       color: '#7A1E2D', icon: '✓' },
    { key: 'early',      color: '#7aade0', icon: '◷' },
    { key: 'notReady',   color: '#5B8DB8', icon: '⏳' },
    { key: 'noProfile',  color: '#3a3a3a', icon: '—' },
  ];

  const hasCoverage = maturityCoverage && maturityCoverage.sommSet > 0;

  return (
    <div className="drink-window">
      <div className="drink-bar">
        {total > 0 ? segments.map(seg => {
          const count = maturity[seg.key] || 0;
          const pct   = (count / total) * 100;
          if (pct === 0) return null;
          return (
            <div key={seg.key} className="drink-segment"
              style={{ width: `${pct}%`, background: seg.color }}
              title={`${t(`statistics.maturityPhases.${seg.key}`)}: ${count}`} />
          );
        }) : (
          <div className="drink-segment" style={{ width: '100%', background: '#252525' }} />
        )}
      </div>
      <div className="drink-legend">
        {segments.map(seg => {
          const count = maturity[seg.key] || 0;
          return (
            <div key={seg.key} className="drink-legend-item">
              <span className="drink-legend-dot" style={{ background: seg.color }} />
              <span className="drink-legend-icon">{seg.icon}</span>
              <span className="drink-legend-label">{t(`statistics.maturityPhases.${seg.key}`)}</span>
              <span className="drink-legend-count"
                style={{ color: count > 0 && seg.key !== 'noProfile' ? seg.color : undefined }}>
                {count}
              </span>
            </div>
          );
        })}
      </div>
      {hasCoverage && (
        <div className="drink-coverage-note">
          {t('statistics.maturity.withProfiles', { count: maturityCoverage.sommSet })}
          {maturityCoverage.none > 0 && ` · ${t('statistics.maturity.withoutData', { count: maturityCoverage.none })}`}
        </div>
      )}
    </div>
  );
}

// ── Cellar Health Score ───────────────────────────────────────────────────────
function HealthScoreCard({ healthScore, healthGrade, maturity }) {
  const { t } = useTranslation();
  const score    = healthScore ?? 0;
  const gradeColor = healthGrade ? (GRADE_COLORS[healthGrade] || '#7A1E2D') : '#555';
  const withProfile = (maturity.declining || 0) + (maturity.late || 0) + (maturity.peak || 0) + (maturity.early || 0) + (maturity.notReady || 0);

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
          <span className="health-dot" style={{ background: '#7A1E2D' }} />
          <span className="health-label">{t('statistics.maturityPhases.peak')}</span>
          <span className="health-val">{maturity.peak}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#7aade0' }} />
          <span className="health-label">{t('statistics.maturityPhases.early')}</span>
          <span className="health-val">{maturity.early}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#D4A070' }} />
          <span className="health-label">{t('statistics.maturityPhases.late')}</span>
          <span className="health-val">{maturity.late}</span>
        </div>
        <div className="health-row">
          <span className="health-dot" style={{ background: '#C94040' }} />
          <span className="health-label">{t('statistics.maturityPhases.declining')}</span>
          <span className="health-val">{maturity.declining}</span>
        </div>
        {withProfile === 0 && (
          <p className="stats-empty" style={{ margin: '0.5rem 0 0' }}>
            {t('statistics.maturity.profilesNeeded')}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Regret Index ──────────────────────────────────────────────────────────────
function RegretIndexCard({ regretIndex, decliningCount, total }) {
  const { t } = useTranslation();
  const level =
    regretIndex >= 30 ? 'critical' :
    regretIndex >= 15 ? 'warning'  :
    regretIndex > 0   ? 'mild'     : 'great';

  const levelColors = {
    critical: '#C94040',
    warning:  '#D4A070',
    mild:     '#D4C87A',
    great:    '#7A1E2D',
  };

  const color = levelColors[level];

  return (
    <div className="regret-card">
      <div className="regret-number" style={{ color }}>
        {regretIndex}%
      </div>
      <div className="regret-label">{t('statistics.sections.regretIndex')}</div>
      <div className="regret-desc">
        {t('statistics.regret.pastPrime', { count: decliningCount })}
      </div>
      <div className="regret-message" style={{ borderLeftColor: color, color: '#E8DFD0' }}>
        {t(`statistics.regret.${level}`)}
      </div>
      {total > 0 && (
        <div className="regret-bar-wrap">
          <div className="regret-bar-track">
            <div
              className="regret-bar-fill"
              style={{ width: `${Math.min(100, regretIndex)}%`, background: color }}
            />
          </div>
          <span className="regret-bar-label">{t('statistics.regret.ofProfiled')}</span>
        </div>
      )}
    </div>
  );
}

// ── Maturity Forecast ─────────────────────────────────────────────────────────
function MaturityForecastChart({ forecast }) {
  const { t } = useTranslation();
  if (!forecast || forecast.length === 0) return <p className="stats-empty">{t('statistics.noForecast')}</p>;
  const maxCount = Math.max(...forecast.map(d => d.count), 1);
  const BAR_H    = 120;

  return (
    <div className="forecast-chart">
      {forecast.map((d, i) => (
        <div key={i} className={`forecast-col${d.isCurrent ? ' forecast-col--current' : ''}`}
          title={t('statistics.forecast.inWindow', { year: d.year, count: d.count })}>
          <div className="forecast-count">{d.count > 0 ? d.count : ''}</div>
          <div className="forecast-bar"
            style={{ height: `${Math.max(d.count > 0 ? 4 : 0, (d.count / maxCount) * BAR_H)}px` }} />
          <div className="forecast-year">{d.year}</div>
          {d.isCurrent && <div className="forecast-now-label">{t('statistics.forecast.now')}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Urgency Ladder ────────────────────────────────────────────────────────────
function UrgencyLadder({ bottles, currency }) {
  const { t } = useTranslation();
  if (!bottles || bottles.length === 0) {
    return (
      <p className="stats-empty">
        {t('statistics.urgency.noUrgent')}
      </p>
    );
  }

  return (
    <ol className="urgency-list">
      {bottles.map((b, i) => {
        const isDeclining = b.status === 'declining';
        const color       = isDeclining ? '#C94040' : '#D4A070';
        return (
          <li key={i} className="urgency-item">
            <span className="urgency-rank" style={{ color }}>{i + 1}</span>
            <span className="urgency-type-dot"
              style={{ background: TYPE_COLORS[b.type] || '#7A1E2D' }}
              title={t(`statistics.typeLabels.${b.type}`, { defaultValue: b.type })} />
            <div className="urgency-info">
              <div className="urgency-name" title={b.name}>{b.name}</div>
              <div className="urgency-meta">
                {b.producer}{b.producer && b.vintage ? ' · ' : ''}{b.vintage}
                {b.source === 'somm' && <span className="urgency-source-badge">somm</span>}
              </div>
            </div>
            <div className="urgency-right">
              <span className="urgency-days" style={{ color }}>
                {isDeclining
                  ? t('statistics.days.ago', { count: Math.abs(b.daysRemaining || 0) })
                  : fmtDays(b.daysRemaining, t)}
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
  const { t } = useTranslation();
  const hasData = holdingTime && holdingTime.some(d => d.count > 0);
  if (!hasData) {
    return (
      <p className="stats-empty">
        {t('statistics.holdingTime.empty')}
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
        {t('statistics.holdingTime.note')}
      </p>
    </div>
  );
}

// ── Joy Per Dollar ────────────────────────────────────────────────────────────
function JoyPerDollarChart({ data, currency, targetScale }) {
  const { t } = useTranslation();
  if (!data || data.length === 0) {
    return (
      <p className="stats-empty">
        {t('statistics.joyPerDollar.empty', { currency })}
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
              style={{ background: TYPE_COLORS[d.type] || '#7A1E2D' }} />
            <span className="jpd-label">{t(`statistics.typeLabels.${d.type}`, { defaultValue: d.type })}</span>
            <div className="jpd-track">
              <div className="jpd-fill"
                style={{
                  width:      `${(d.score / maxScore) * 100}%`,
                  background: TYPE_COLORS[d.type] || '#7A1E2D',
                }} />
            </div>
            <div className="jpd-stats">
              <span className="jpd-rating">{fmtRating(d.avgRating, targetScale)}</span>
              <span className="jpd-price">{t('statistics.joyPerDollar.avg', { price: fmtCurrency(d.avgPrice, currency) })}</span>
              <span className="jpd-count">{t('statistics.joyPerDollar.count', { count: d.count })}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="jpd-note">{t('statistics.joyPerDollar.note', { currency })}</p>
    </div>
  );
}

// ── Regret Signal (expectation vs reality) ────────────────────────────────────
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
            🎉 {t('statistics.regretSignal.surprises')}
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
                <div className="rs-ratings">{fmtRating(b.rating, targetScale)} → {fmtRating(b.consumedRating, targetScale)}</div>
              </div>
            ))}
        </div>
        <div className="regret-signal-col">
          <div className="regret-signal-col-header regret-signal-col-header--bad">
            😬 {t('statistics.regretSignal.disappointments')}
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
  const { t } = useTranslation();
  const { avgIntakePerYear, avgOutputPerYear, netPerYear, runway } = pace;
  const isGrowing    = netPerYear > 0;
  const isShrinking  = netPerYear < 0;
  const netColor     = isGrowing ? '#7aade0' : isShrinking ? '#C94040' : '#9A9484';
  const netLabel     = isGrowing
    ? t('statistics.pace.growing')
    : isShrinking
      ? t('statistics.pace.shrinking')
      : t('statistics.pace.balanced');

  return (
    <div className="pace-card">
      <div className="pace-stats">
        <div className="pace-stat">
          <span className="pace-stat-value">{avgIntakePerYear}</span>
          <span className="pace-stat-label">{t('statistics.pace.bottlesIn')}</span>
        </div>
        <div className="pace-divider" />
        <div className="pace-stat">
          <span className="pace-stat-value">{avgOutputPerYear}</span>
          <span className="pace-stat-label">{t('statistics.pace.bottlesOut')}</span>
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
            {t('statistics.pace.runway', { count: runway })}
          </span>
        </div>
      )}
      {avgOutputPerYear === 0 && (
        <p className="stats-empty" style={{ marginTop: '0.75rem' }}>
          {t('statistics.pace.consumeToSee')}
        </p>
      )}
    </div>
  );
}

// ── Consumption History (stacked bar) ────────────────────────────────────────
function ConsumptionChart({ consumptionByYear, consumptionByReason }) {
  const { t } = useTranslation();
  if (!consumptionByYear || consumptionByYear.length === 0) {
    return (
      <p className="stats-empty">
        {t('statistics.consumption.empty')}
      </p>
    );
  }

  const reasons  = ['drank', 'gifted', 'sold', 'other'];
  const reasonLabels = {
    drank:  t('statistics.consumption.drank'),
    gifted: t('statistics.consumption.gifted'),
    sold:   t('statistics.consumption.sold'),
    other:  t('statistics.consumption.other'),
  };
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
              <div className="consumption-bar-count">{yearTotal > 0 ? yearTotal : ''}</div>
              <div className="consumption-bar-stack" style={{ height: `${BAR_H}px` }}
                title={t('statistics.vintageBottle', { vintage: d.year, count: yearTotal })}>
                {reasons.map(r => {
                  const h = maxTotal > 0 ? ((d[r] || 0) / maxTotal) * BAR_H : 0;
                  if (h === 0) return null;
                  return (
                    <div key={r} className="consumption-segment"
                      style={{ height: `${h}px`, background: REASON_COLORS[r] }}
                      title={`${reasonLabels[r]}: ${d[r] || 0}`} />
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
            {reasonLabels[r]}: {consumptionByReason[r] || 0}
          </span>
        ))}
      </div>
      <div className="consumption-totals">
        <strong>{t('statistics.consumption.totalConsumed', { count: total })}</strong>
      </div>
    </div>
  );
}

// ── Purchase History ──────────────────────────────────────────────────────────
function PurchaseHistoryChart({ byPurchaseYear }) {
  const { t } = useTranslation();
  if (!byPurchaseYear || byPurchaseYear.length === 0) {
    return <p className="stats-empty">{t('statistics.noPurchaseData')}</p>;
  }
  const maxVal = Math.max(...byPurchaseYear.map(d => d.count), 1);
  const BAR_H  = 80;

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {byPurchaseYear.map((d, i) => (
          <div key={i} className="vintage-bar-wrap"
            title={t('statistics.purchased', { year: d.year, count: d.count })}>
            <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
            <div className="vintage-bar"
              style={{
                height: `${Math.max(4, (d.count / maxVal) * BAR_H)}px`,
                background: 'linear-gradient(to top, #5f7a8a, #7aade0)',
              }} />
            <div className="vintage-bar-label">
              {byPurchaseYear.length > 15 ? String(d.year).slice(-2) : d.year}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Top Value Bottles ─────────────────────────────────────────────────────────
function TopValueList({ bottles, currency }) {
  const { t } = useTranslation();
  if (!bottles || bottles.length === 0) {
    return <p className="stats-empty">{t('statistics.topValue.empty')}</p>;
  }

  return (
    <ol className="top-bottles-list">
      {bottles.map((b, i) => (
        <li key={i} className="top-bottle-item">
          <span className="top-bottle-rank" data-rank={i + 1}>#{i + 1}</span>
          <span className="top-bottle-type-dot"
            style={{ background: TYPE_COLORS[b.type] || '#7A1E2D' }}
            title={t(`statistics.typeLabels.${b.type}`, { defaultValue: b.type })} />
          <div className="top-bottle-info">
            <div className="top-bottle-name" title={b.name}>{b.name}</div>
            <div className="top-bottle-meta">
              {b.producer}{b.producer && b.vintage ? ' · ' : ''}{b.vintage}
            </div>
          </div>
          <span className="top-bottle-price" style={{ color: TYPE_COLORS[b.type] || '#7A1E2D' }}>
            {fmtCurrency(b.price, currency)}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ── Cellar Breakdown ──────────────────────────────────────────────────────────
function CellarBreakdownViz({ cellars, currency }) {
  const { t } = useTranslation();
  if (!cellars || cellars.length === 0) return <p className="stats-empty">{t('statistics.noCellars')}</p>;
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
            <span>{t('statistics.cellarBreakdown.bottle', { count: c.bottleCount })}</span>
            <span>{t('statistics.cellarBreakdown.uniqueWine', { count: c.uniqueWines })}</span>
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
  const sizeColors = ['#7A1E2D', '#6EC6C6', '#D4C87A', '#D4A070', '#8B6A9A'];

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
  const { t } = useTranslation();
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
              {t('statistics.worldMap.bottle', { count: hovered.count })}
            </span>
          </>
        ) : (
          <span className="worldmap-info-hint">{t('statistics.worldMap.hoverHint')}</span>
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
          <span className="worldmap-legend-unit">{t('statistics.worldMap.legendUnit')}</span>
        </div>
        {unmappedCount > 0 && (
          <span className="worldmap-legend-note">
            {t('statistics.worldMap.unmapped', { count: unmappedCount })}
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
  const { t } = useTranslation();
  return (
    <div className="premium-gate">
      <div className="premium-gate-glow" />
      <div className="premium-gate-icon">📊</div>
      <h1>{t('statistics.title')}</h1>
      <p className="premium-gate-sub">
        {t('statistics.premiumGate.desc')}
      </p>
      <div className="premium-gate-features">
        <div className="pgf-item"><span>🍷</span> {t('statistics.premiumGate.feat1')}</div>
        <div className="pgf-item"><span>📅</span> {t('statistics.premiumGate.feat2')}</div>
        <div className="pgf-item"><span>💰</span> {t('statistics.premiumGate.feat3')}</div>
        <div className="pgf-item"><span>⏱</span> {t('statistics.premiumGate.feat4')}</div>
        <div className="pgf-item"><span>🎯</span> {t('statistics.premiumGate.feat5')}</div>
        <div className="pgf-item"><span>😬</span> {t('statistics.premiumGate.feat6')}</div>
        <div className="pgf-item"><span>🚨</span> {t('statistics.premiumGate.feat7')}</div>
        <div className="pgf-item"><span>💎</span> {t('statistics.premiumGate.feat8')}</div>
      </div>
      <Link to="/plans" className="btn btn-primary premium-gate-btn">
        {t('statistics.premiumGate.upgradeBtn')}
      </Link>
      <p className="premium-gate-trial">
        {t('statistics.premiumGate.notSure')} <Link to="/plans">{t('statistics.premiumGate.startTrial')}</Link>
      </p>
    </div>
  );
}

// ── Upgrade Card (inline upsell for locked sections) ─────────────────────────
function UpgradeCard({ plan = 'basic', features = [], fullWidth = false }) {
  const { t } = useTranslation();
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
        <p className="upgrade-card-tagline">{t('statistics.upgrade.unlockWith', { plan: label })}</p>
        {features.length > 0 && (
          <div className="upgrade-card-features">
            {features.map((f, i) => (
              <span key={i} className="upgrade-card-feature">{f}</span>
            ))}
          </div>
        )}
        <Link to="/plans" className="btn upgrade-card-btn" style={{ borderColor: color, color }}>
          {t('statistics.upgrade.upgradeTo', { plan: label })}
        </Link>
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────
function EmptyCollection() {
  const { t } = useTranslation();
  return (
    <div className="stats-empty-state">
      <div className="stats-empty-icon">🍾</div>
      <h2>{t('statistics.emptyTitle')}</h2>
      <p>{t('statistics.emptyDesc')}</p>
      <Link to="/cellars" className="btn btn-primary">{t('statistics.emptyBtn')}</Link>
    </div>
  );
}

// ── Main Statistics Page ──────────────────────────────────────────────────────
function Statistics() {
  const { t } = useTranslation();
  const { user, apiFetch } = useAuth();
  const [stats, setStats]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]  = useState(null);
  const [valueHistory, setValueHistory] = useState(null);

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

  // Fetch value history for premium users (parallel with overview)
  const loadValueHistory = useCallback(async () => {
    if (!isPremium) return;
    try {
      const res = await getValueHistory(apiFetch);
      const data = await res.json();
      if (res.ok && data.valueHistory) setValueHistory(data.valueHistory);
    } catch {}
  }, [apiFetch, isPremium]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadValueHistory(); }, [loadValueHistory]);

  if (loading) {
    return (
      <div className="stats-page stats-loading">
        <div className="stats-spinner" />
        <p>{t('statistics.loading')}</p>
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
    maturity, maturityCoverage, topValueBottles,
    consumptionByYear, consumptionByReason, cellarBreakdown,
    maturityForecast, urgencyLadder, holdingTime,
    joyPerDollar, regretSignal, pace, topProducers,
  } = stats;

  if (overview.totalBottles === 0 && overview.totalConsumed === 0) {
    return <div className="stats-page"><EmptyCollection /></div>;
  }

  const typeSegments = Object.entries(byType)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, value]) => ({
      type, label: t(`statistics.typeLabels.${type}`, { defaultValue: type }),
      value, color: TYPE_COLORS[type] || '#6a6a6a',
    }));

  const total          = overview.totalBottles;
  const currency       = overview.currency;
  const targetScale    = overview.targetRatingScale || '5';
  const hasConsumption = overview.totalConsumed > 0;
  const hasMultipleSizes = Object.keys(byBottleSize).length > 1;
  const hasPurchaseDates = byPurchaseYear && byPurchaseYear.length > 0;
  const hasUrgency     = urgencyLadder && urgencyLadder.length > 0;
  const hasForecast    = maturityForecast && maturityForecast.some(d => d.count > 0);
  const hasProducers   = topProducers && topProducers.length > 0;

  const PREMIUM_FEATURES = [
    t('statistics.upgradeFeatures.premium1'),
    t('statistics.upgradeFeatures.premium2'),
    t('statistics.upgradeFeatures.premium3'),
    t('statistics.upgradeFeatures.premium4'),
    t('statistics.upgradeFeatures.premium5'),
    t('statistics.upgradeFeatures.premium6'),
    t('statistics.upgradeFeatures.premium7'),
    t('statistics.upgradeFeatures.premium8'),
  ];

  return (
    <div className="stats-page">

      {/* ── Header ── */}
      <div className="stats-header">
        <div className="stats-title-row">
          <h1 className="stats-title">{t('statistics.title')}</h1>
          <Link to="/statistics/card" className="btn btn-small btn-secondary stats-card-link">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            {t('statsCard.createCard', 'Share Card')}
          </Link>
        </div>
        <p className="stats-subtitle">
          {isBasic
            ? t('statistics.subtitleFull', {
                cellars: overview.totalCellars,
                count: overview.totalCellars,
                countries: overview.totalCountries,
                grapes: overview.totalGrapes,
              })
            : t('statistics.subtitleFree')
          }
        </p>
        {isPremium
          ? <span className="stats-plan-badge stats-plan-badge--premium">★ Premium</span>
          : isBasic
            ? <span className="stats-plan-badge stats-plan-badge--basic">Basic</span>
            : null
        }
      </div>

      {/* ── Primary KPIs ── */}
      <div className={`kpi-grid${isPremium ? '' : isBasic ? ' kpi-grid--5' : ' kpi-grid--5'}`}>
        <KPICard icon="🍾" label={t('statistics.kpi.activeBottles')} value={fmt(total)}
          sub={t('statistics.kpi.uniqueWines', { count: overview.uniqueWines })} accentColor="#7A1E2D" />
        <KPICard icon="🌍" label={t('statistics.kpi.countries')} value={fmt(overview.totalCountries)}
          sub={t('statistics.kpi.grapeVarieties', { count: overview.totalGrapes })} accentColor="#6EC6C6" />
        <KPICard icon="⭐" label={t('statistics.kpi.avgRating')}
          value={overview.avgRating != null ? fmtRating(overview.avgRating, targetScale) : '—'}
          accentColor="#D4C87A" />
        <KPICard icon="📅" label={t('statistics.kpi.avgVintageAge')}
          value={overview.avgVintageAge ? `${overview.avgVintageAge} ${t('statistics.kpi.yrs')}` : '—'}
          sub={overview.oldestVintage
            ? `${overview.oldestVintage} → ${overview.newestVintage}` : undefined}
          accentColor="#8B6A9A" />
        <KPICard icon="⏱" label={t('statistics.kpi.decliningLate')}
          value={`${(maturity.declining || 0) + (maturity.late || 0)}`}
          sub={maturity.declining > 0
            ? t('statistics.kpi.pastPrime', { count: maturity.declining })
            : t('statistics.kpi.atPeak', { count: maturity.peak || 0 })}
          accentColor={maturity.declining > 0 ? '#C94040' : '#7A1E2D'} />
        {isPremium && (
          <KPICard icon="💰" label={t('statistics.kpi.estValue')}
            value={overview.totalValue > 0 ? fmtCurrency(overview.totalValue, currency) : '—'}
            sub={overview.avgPrice > 0
              ? t('statistics.kpi.avgPerBottle', { price: fmtCurrency(overview.avgPrice, currency) }) : undefined}
            accentColor="#D4A070" />
        )}
      </div>

      {/* ── Secondary KPIs (consumption) — basic+ only ── */}
      {isBasic && hasConsumption && (
        <div className="kpi-grid kpi-grid--secondary">
          <KPICard icon="✓" label={t('statistics.kpi.totalConsumed')} value={fmt(overview.totalConsumed)} />
          <KPICard icon="🥂" label={t('statistics.kpi.bottlesDrunk')}  value={fmt(overview.bottlesDrunk)} />
          <KPICard icon="🎁" label={t('statistics.kpi.gifted')}          value={fmt(overview.bottlesGifted)} />
          <KPICard icon="💵" label={t('statistics.kpi.sold')}            value={fmt(overview.bottlesSold)} />
          {overview.avgConsumedRating != null && (
            <KPICard icon="🌟" label={t('statistics.kpi.avgConsumedRating')}
              value={fmtRating(overview.avgConsumedRating, targetScale)} />
          )}
        </div>
      )}

      {/* ── Health + Regret row — premium only ── */}
      {isPremium && (
        <div className="stats-grid stats-grid--insight">
          <div className="stats-card">
            <h2 className="stats-card-title">
              {t('statistics.sections.healthScore')}
              <span className="stats-card-title-note">{t('statistics.sections.healthScoreNote')}</span>
            </h2>
            <HealthScoreCard
              healthScore={overview.healthScore}
              healthGrade={overview.healthGrade}
              maturity={maturity}
            />
          </div>
          <div className={`stats-card stats-card--regret${overview.regretIndex >= 15 ? ' stats-card--regret-alert' : ''}`}>
            <h2 className="stats-card-title">
              {t('statistics.sections.regretIndex')}
              <span className="stats-card-title-note">{t('statistics.sections.regretIndexNote')}</span>
            </h2>
            <RegretIndexCard
              regretIndex={overview.regretIndex}
              decliningCount={maturity.declining}
              total={total}
            />
          </div>
        </div>
      )}

      {/* ── Collection Value Over Time — premium only ── */}
      {isPremium && valueHistory && valueHistory.snapshots.length > 1 && (
        <div className="stats-grid">
          <div className="stats-card stats-card--full">
            <h2 className="stats-card-title">
              {t('statistics.sections.valueOverTime', 'Collection Value Over Time')}
              {valueHistory.changePercent !== 0 && (
                <span className="stats-card-title-note" style={{
                  color: valueHistory.changePercent >= 0 ? '#2D7A45' : '#C0504D'
                }}>
                  {valueHistory.changePercent >= 0 ? '+' : ''}{valueHistory.changePercent}%
                </span>
              )}
            </h2>
            <ValueOverTimeChart
              snapshots={valueHistory.snapshots}
              currency={valueHistory.currency}
            />
          </div>
        </div>
      )}
      {isPremium && valueHistory && valueHistory.snapshots.length <= 1 && (
        <div className="stats-grid">
          <div className="stats-card stats-card--full">
            <h2 className="stats-card-title">
              {t('statistics.sections.valueOverTime', 'Collection Value Over Time')}
            </h2>
            <p className="value-chart-seed-msg">
              {valueHistory.snapshots.length === 0
                ? 'Value tracking has started. Your first data point will appear after the weekly snapshot runs.'
                : 'Your first snapshot is recorded. Trend data will appear after next week\'s snapshot.'}
            </p>
          </div>
        </div>
      )}

      {/* ── Main Grid ── */}
      <div className="stats-grid">

        {/* Wine Types Donut — FREE+ */}
        <div className="stats-card">
          <h2 className="stats-card-title">{t('statistics.sections.wineTypes')}</h2>
          {total > 0 ? (
            <div className="donut-layout">
              <DonutChart segments={typeSegments} total={total} />
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
            <p className="stats-empty">{t('statistics.noBottlesYet')}</p>
          )}
        </div>

        {/* Drinking Windows — FREE+ */}
        <div className="stats-card">
          <h2 className="stats-card-title">{t('statistics.sections.maturityStatus')}</h2>
          <MaturityViz maturity={maturity} maturityCoverage={maturityCoverage} total={total} />
        </div>

        {/* Vintage Distribution — BASIC+ */}
        {isBasic && (
          <div className="stats-card stats-card--full">
            <h2 className="stats-card-title">
              {t('statistics.sections.vintageDistribution')}
              {overview.oldestVintage && (
                <span className="stats-card-title-note">
                  {overview.oldestVintage} – {overview.newestVintage}
                </span>
              )}
            </h2>
            <VintageBarChart data={byVintage} />
          </div>
        )}

        {/* Rating Distribution — FREE+ */}
        {!isBasic && (
          <div className="stats-card">
            <h2 className="stats-card-title">{t('statistics.sections.ratingDistribution')}</h2>
            <RatingChart byRating={byRating} avg={overview.avgRating} targetScale={targetScale} />
          </div>
        )}

        {/* Top 5 Origins — FREE only */}
        {!isBasic && (
          <div className="stats-card">
            <h2 className="stats-card-title">
              {t('statistics.sections.topOrigins')}
              <span className="stats-card-title-note">{t('statistics.sections.top5')}</span>
            </h2>
            <HBarChart data={byCountry} colors={COUNTRY_COLORS} maxItems={5} />
          </div>
        )}

        {/* Upgrade cards — FREE users only */}
        {!isBasic && (
          <>
            <UpgradeCard plan="basic" fullWidth features={[
              t('statistics.upgradeFeatures.basic1'),
              t('statistics.upgradeFeatures.basic2'),
              t('statistics.upgradeFeatures.basic3'),
              t('statistics.upgradeFeatures.basic4'),
              t('statistics.upgradeFeatures.basic5'),
              t('statistics.upgradeFeatures.basic6'),
              t('statistics.upgradeFeatures.basic7'),
              t('statistics.upgradeFeatures.basic8'),
            ]} />
            <UpgradeCard plan="premium" fullWidth features={PREMIUM_FEATURES} />
          </>
        )}

        {/* ── BASIC+ sections ── */}
        {isBasic && (
          <>
            {/* World Map — BASIC (desktop only, hover-based) */}
            <div className="stats-card stats-card--full stats-card--desktop-only">
              <h2 className="stats-card-title">
                {t('statistics.sections.collectionOrigins')}
                <span className="stats-card-title-note">{t('statistics.sections.darkerMoreBottles')}</span>
              </h2>
              <WorldMapChart byCountry={byCountry} />
            </div>

            {/* Top Origins — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">{t('statistics.sections.topOrigins')}</h2>
              <HBarChart data={byCountry} colors={COUNTRY_COLORS} />
            </div>

            {/* Top Grape Varieties — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">{t('statistics.sections.topGrapeVarieties')}</h2>
              <HBarChart data={byGrape} colors={GRAPE_COLORS} />
            </div>

            {/* Top Regions — BASIC */}
            {byRegion && byRegion.length > 0 && (
              <div className="stats-card">
                <h2 className="stats-card-title">{t('statistics.sections.topRegions')}</h2>
                <HBarChart data={byRegion}
                  colors={['#7aade0', '#6a9dd0', '#5a8dc0', '#4a7db0', '#3a6da0']} />
              </div>
            )}

            {/* Top Producers — BASIC */}
            {hasProducers && (
              <div className="stats-card">
                <h2 className="stats-card-title">{t('statistics.sections.topProducers')}</h2>
                <HBarChart data={topProducers}
                  colors={['#D4A070', '#C4906A', '#B48064', '#A4705E', '#946058']} />
              </div>
            )}

            {/* Rating Distribution — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">{t('statistics.sections.ratingDistribution')}</h2>
              <RatingChart byRating={byRating} avg={overview.avgRating} targetScale={targetScale} />
            </div>

            {/* Bottle Sizes — BASIC */}
            {hasMultipleSizes && (
              <div className="stats-card">
                <h2 className="stats-card-title">{t('statistics.sections.bottleSizes')}</h2>
                <BottleSizeChart byBottleSize={byBottleSize} />
              </div>
            )}

            {/* Purchase History — BASIC (desktop only, scrolling bar chart) */}
            {hasPurchaseDates && (
              <div className="stats-card stats-card--desktop-only">
                <h2 className="stats-card-title">{t('statistics.sections.purchasesByYear')}</h2>
                <PurchaseHistoryChart byPurchaseYear={byPurchaseYear} />
              </div>
            )}

            {/* Pace — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">
                {t('statistics.sections.cellarPace')}
                <span className="stats-card-title-note">{t('statistics.sections.intakeVsConsumption')}</span>
              </h2>
              <PaceCard pace={pace} totalBottles={total} />
            </div>

            {/* Consumption History — BASIC */}
            <div className="stats-card stats-card--full">
              <h2 className="stats-card-title">{t('statistics.sections.consumptionHistory')}</h2>
              <ConsumptionChart
                consumptionByYear={consumptionByYear}
                consumptionByReason={consumptionByReason}
              />
            </div>

            {/* Cellar Breakdown — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">{t('statistics.sections.cellarBreakdown')}</h2>
              <CellarBreakdownViz cellars={cellarBreakdown} currency={currency} />
            </div>

            {/* Premium upgrade for basic users OR premium-only content */}
            {!isPremium ? (
              <UpgradeCard plan="premium" fullWidth features={PREMIUM_FEATURES} />
            ) : (
              <>
                {/* Maturity Forecast — PREMIUM (desktop only, many columns) */}
                {hasForecast && (
                  <div className="stats-card stats-card--full stats-card--desktop-only">
                    <h2 className="stats-card-title">
                      {t('statistics.sections.maturityForecast')}
                      <span className="stats-card-title-note">{t('statistics.sections.forecastNote')}</span>
                    </h2>
                    <MaturityForecastChart forecast={maturityForecast} />
                  </div>
                )}

                {/* Urgency Ladder — PREMIUM */}
                {hasUrgency && (
                  <div className="stats-card stats-card--full">
                    <h2 className="stats-card-title">
                      {t('statistics.sections.drinkTheseNow')}
                      <span className="stats-card-title-note">{t('statistics.sections.orderedByUrgency')}</span>
                    </h2>
                    <UrgencyLadder bottles={urgencyLadder} currency={currency} />
                  </div>
                )}

                {/* Holding Time — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">
                    {t('statistics.sections.patiencePayoff')}
                    <span className="stats-card-title-note">{t('statistics.sections.doesAgingReward')}</span>
                  </h2>
                  <HoldingTimeChart holdingTime={holdingTime} targetScale={targetScale} />
                </div>

                {/* Joy Per Dollar — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">
                    {t('statistics.sections.joyPer', { currency })}
                    <span className="stats-card-title-note">{t('statistics.sections.ratingVsPrice')}</span>
                  </h2>
                  <JoyPerDollarChart data={joyPerDollar} currency={currency} targetScale={targetScale} />
                </div>

                {/* Regret Signal — PREMIUM (desktop only, complex two-column layout) */}
                {hasConsumption && (
                  <div className="stats-card stats-card--full stats-card--desktop-only">
                    <h2 className="stats-card-title">
                      {t('statistics.sections.expectationVsReality')}
                      <span className="stats-card-title-note">{t('statistics.sections.surprisedOrDisappointed')}</span>
                    </h2>
                    <RegretSignalCard regretSignal={regretSignal} targetScale={targetScale} />
                  </div>
                )}

                {/* Most Valuable Bottles — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">{t('statistics.sections.mostValuableBottles')}</h2>
                  <TopValueList bottles={topValueBottles} currency={currency} />
                </div>
              </>
            )}
          </>
        )}

      </div>

      <p className="stats-footnote">
        {t('statistics.footnote.activeOnly')} ·{' '}
        {isPremium && `${t('statistics.footnote.pricesConverted', { currency })} · `}
        {t('statistics.footnote.maturityData')} ·
        {' '}{t('statistics.footnote.ownedOnly')}
      </p>
    </div>
  );
}

export default Statistics;
